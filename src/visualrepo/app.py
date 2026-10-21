"""
app.py — FastAPI 后端，为前端地图提供数据 API
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pathlib import Path
import duckdb
import os
import json
import asyncio

from visualrepo.author_profiler import build_profile, build_llm_prompt, profile_to_dict
from visualrepo.git_ingest import init_db
from visualrepo.paths import db_path as _db_path

DB_PATH = str(_db_path())

app = FastAPI(title="Visual Repo API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# 数据库文件可能还不存在（例如从未索引过任何仓库就直接 `visualrepo serve`），
# 这里先确保建表，再以只读模式打开常驻连接。
if not Path(DB_PATH).exists():
    init_db(DB_PATH).close()

# 进程级只读根连接：DuckDB 每次 connect() 需重新加载数据库实例（~4ms），
# cursor() 从已加载实例派生独立执行上下文（~0.05ms），且线程安全。
_ROOT_CON = duckdb.connect(DB_PATH, read_only=True)


def get_con():
    return _ROOT_CON.cursor()


# ─────────────────────────────────────────────
# /api/repos  — 已索引的仓库列表
# ─────────────────────────────────────────────
@app.get("/api/repos")
def list_repos():
    con = get_con()
    rows = con.execute("""
        SELECT r.repo_id, r.name, r.path, r.last_hash, r.indexed_at,
               COUNT(DISTINCT c.hash)       AS commit_count,
               COUNT(DISTINCT a.email)      AS author_count
        FROM repos r
        LEFT JOIN commits c  ON c.repo_id = r.repo_id
        LEFT JOIN authors a  ON a.repo_id = r.repo_id
        GROUP BY r.repo_id, r.name, r.path, r.last_hash, r.indexed_at
    """).fetchall()
    con.close()
    return [
        {
            "repo_id": r[0], "name": r[1], "path": r[2],
            "last_hash": r[3], "indexed_at": r[4],
            "commit_count": r[5], "author_count": r[6],
        }
        for r in rows
    ]


# ─────────────────────────────────────────────
# /api/authors  — 仓库的贡献者列表
# ─────────────────────────────────────────────
@app.get("/api/authors")
def list_authors(repo_id: str):
    con = get_con()
    rows = con.execute("""
        SELECT email, name, username, commit_count
        FROM authors
        WHERE repo_id = ?
        ORDER BY commit_count DESC
    """, [repo_id]).fetchall()
    con.close()

    result = []
    for r in rows:
        email, git_name, username, commit_count = r
        result.append({
            "email": email,
            "name": git_name,
            "username": username,
            "commit_count": commit_count,
        })
    return result


# ─────────────────────────────────────────────
# /api/treemap  — Treemap 节点数据（核心接口）
#
# 返回树形结构，每个节点包含：
#   - path, size（代码行数 / churn）
#   - top_owners: [{email, name, username, churn, pct}]
#   - children（目录节点）
# ─────────────────────────────────────────────
@app.get("/api/treemap")
def get_treemap(
    repo_id: str,
    ts_from: int = Query(0, description="Unix timestamp, start"),
    ts_to:   int = Query(9999999999, description="Unix timestamp, end"),
    emails:  str = Query("", description="Comma-separated emails to highlight"),
    depth:   int = Query(3, description="Max directory depth to return"),
    mode:    str = Query("active", description="active=churn面积, loc=净行数面积"),
):
    con = get_con()

    email_list = [e.strip() for e in emails.split(",") if e.strip()] if emails else []

    # 查询时间范围内每个文件的每个作者的 churn（ownership 始终用 active 口径）
    rows = con.execute("""
        SELECT
            cf.file_path,
            c.author_email,
            a.name               AS author_name,
            a.username,
            SUM(cf.additions + cf.deletions) AS churn,
            COUNT(*)             AS touches
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        JOIN authors a ON c.author_email = a.email AND a.repo_id = cf.repo_id
        WHERE cf.repo_id = ?
          AND c.ts BETWEEN ? AND ?
        GROUP BY cf.file_path, c.author_email, a.name, a.username
        ORDER BY cf.file_path, churn DESC
    """, [repo_id, ts_from, ts_to]).fetchall()

    # LoC 模式：取 B 时刻（ts_to）之前所有 commit 的累计净行数作为面积
    loc_map: dict[str, int] = {}
    if mode == "loc":
        loc_rows = con.execute("""
            SELECT cf.file_path,
                   SUM(cf.additions) - SUM(cf.deletions) AS net_loc
            FROM commit_files cf
            JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
            WHERE cf.repo_id = ?
              AND c.ts <= ?
            GROUP BY cf.file_path
        """, [repo_id, ts_to]).fetchall()
        loc_map = {r[0]: max(r[1], 1) for r in loc_rows if r[1] > 0}

    con.close()

    # 构建文件级聚合
    file_data: dict[str, dict] = {}
    for file_path, email, name, username, churn, touches in rows:
        if file_path not in file_data:
            file_data[file_path] = {"total_churn": 0, "total_loc": 0, "owners": []}
        file_data[file_path]["total_churn"] += churn
        file_data[file_path]["owners"].append({
            "email": email,
            "name": name,
            "username": username,
            "churn": churn,
            "touches": touches,
            "highlighted": email in email_list if email_list else False,
        })

    # 填充 LoC（loc 模式下用累计净行数，active 模式下 total_loc 置 0 即可）
    for fpath, data in file_data.items():
        data["total_loc"] = loc_map.get(fpath, 0)

    # LoC 模式：loc_map 里有但 active 窗口内没有改动的文件也要补充进来（只展示面积，无 owner）
    if mode == "loc":
        for fpath, loc in loc_map.items():
            if fpath not in file_data:
                file_data[fpath] = {"total_churn": 0, "total_loc": loc, "owners": []}

    # 计算每个文件各 owner 的占比
    for fpath, data in file_data.items():
        total = data["total_churn"] or 1
        for owner in data["owners"]:
            owner["pct"] = round(owner["churn"] / total * 100, 1)
        data["owners"] = data["owners"][:5]  # 最多返回 top-5

    # 叶子数量上限：voronoi 在 ~2000 叶子以上容易不收敛，按 churn/loc 降序保留 top-N
    MAX_LEAVES = 2000
    sort_key = "total_loc" if mode == "loc" else "total_churn"
    if len(file_data) > MAX_LEAVES:
        file_data = dict(
            sorted(file_data.items(), key=lambda kv: kv[1][sort_key], reverse=True)[:MAX_LEAVES]
        )

    # 构建树形结构
    root = _build_tree(file_data, depth, mode)
    return root


def _build_tree(file_data: dict, max_depth: int, mode: str = "active") -> dict:
    """将文件列表聚合成树形结构"""
    tree: dict = {"name": "root", "path": "", "children": {}, "total_churn": 0, "total_loc": 0, "owners": {}}

    for file_path, data in file_data.items():
        parts = Path(file_path).parts
        node = tree
        for i, part in enumerate(parts):
            if i == len(parts) - 1:
                node["children"][part] = {
                    "name": part,
                    "path": file_path,
                    "type": "file",
                    "total_churn": data["total_churn"],
                    "total_loc": data["total_loc"],
                    "owners": data["owners"],
                    "children": {},
                }
            else:
                if part not in node["children"]:
                    node["children"][part] = {
                        "name": part,
                        "path": "/".join(str(p) for p in parts[: i + 1]),
                        "type": "dir",
                        "total_churn": 0,
                        "total_loc": 0,
                        "owners": {},
                        "children": {},
                    }
                node = node["children"][part]
                node["total_churn"] += data["total_churn"]
                node["total_loc"]   += data["total_loc"]

    _aggregate_dir_owners(tree)
    return _serialize_tree(tree, max_depth, 0, mode)


def _aggregate_dir_owners(node: dict) -> None:
    """自底向上：把子孙文件的 owner churn 汇总到每个 dir 节点"""
    if not node.get("children"):
        return
    for child in node["children"].values():
        _aggregate_dir_owners(child)

    if node.get("type") == "file":
        return

    # 汇总所有子孙 owner churn
    merged: dict[str, dict] = {}
    for child in node["children"].values():
        owners = child.get("owners") or []
        if isinstance(owners, dict):
            continue
        for o in owners:
            email = o["email"]
            if email not in merged:
                merged[email] = {k: v for k, v in o.items()}
                merged[email]["churn"] = 0
            merged[email]["churn"] += o.get("churn", 0)

    if not merged:
        return

    total = sum(v["churn"] for v in merged.values()) or 1
    owners_list = sorted(merged.values(), key=lambda x: x["churn"], reverse=True)[:5]
    for o in owners_list:
        o["pct"] = round(o["churn"] / total * 100, 1)
        o["highlighted"] = False
    node["owners"] = owners_list


def _serialize_tree(node: dict, max_depth: int, current_depth: int, mode: str = "active") -> dict:
    children = list(node["children"].values())
    # 排序字段：loc 模式按 total_loc，active 按 total_churn
    sort_key = "total_loc" if mode == "loc" else "total_churn"
    children.sort(key=lambda x: x[sort_key], reverse=True)

    serialized_children = []
    if current_depth < max_depth:
        for child in children:
            serialized_children.append(
                _serialize_tree(child, max_depth, current_depth + 1, mode)
            )
    else:
        for child in children:
            serialized_children.append({
                "name": child["name"],
                "path": child["path"],
                "type": child["type"],
                "total_churn": child["total_churn"],
                "total_loc": child["total_loc"],
                "owners": child.get("owners", []),
                "children": [],
            })

    return {
        "name": node["name"],
        "path": node["path"],
        "type": node.get("type", "dir"),
        "total_churn": node["total_churn"],
        "total_loc": node["total_loc"],
        "owners": node.get("owners", []),
        "children": serialized_children,
    }


# ─────────────────────────────────────────────
# /api/timeline  — 时间范围内每月 commit 热度
# ─────────────────────────────────────────────
@app.get("/api/timeline")
def get_timeline(
    repo_id: str,
    emails: str = Query("", description="Comma-separated emails"),
):
    con = get_con()
    email_list = [e.strip() for e in emails.split(",") if e.strip()] if emails else []

    if email_list:
        placeholders = ",".join(["?" for _ in email_list])
        rows = con.execute(f"""
            SELECT
                CAST(strftime(to_timestamp(ts), '%Y-%m') AS VARCHAR) AS month,
                author_email,
                COUNT(*) AS cnt
            FROM commits
            WHERE repo_id = ?
              AND author_email IN ({placeholders})
            GROUP BY month, author_email
            ORDER BY month
        """, [repo_id] + email_list).fetchall()
    else:
        rows = con.execute("""
            SELECT
                CAST(strftime(to_timestamp(ts), '%Y-%m') AS VARCHAR) AS month,
                author_email,
                COUNT(*) AS cnt
            FROM commits
            WHERE repo_id = ?
            GROUP BY month, author_email
            ORDER BY month
        """, [repo_id]).fetchall()

    con.close()

    result: dict[str, dict] = {}
    for month, email, cnt in rows:
        if month not in result:
            result[month] = {"month": month, "total": 0, "by_author": {}}
        result[month]["total"] += cnt
        result[month]["by_author"][email] = cnt

    return sorted(result.values(), key=lambda x: x["month"])


# ─────────────────────────────────────────────
# /api/person_territory  — 某人的领土覆盖
# ─────────────────────────────────────────────
@app.get("/api/person_territory")
def get_person_territory(
    repo_id: str,
    email: str,
    ts_from: int = Query(0),
    ts_to:   int = Query(9999999999),
    top_n:   int = Query(20, description="Top N files by churn"),
):
    con = get_con()
    rows = con.execute("""
        SELECT
            cf.file_path,
            SUM(cf.additions + cf.deletions) AS churn,
            COUNT(*)                          AS touches,
            MIN(c.ts)                         AS first_touch,
            MAX(c.ts)                         AS last_touch
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        WHERE cf.repo_id = ?
          AND c.author_email = ?
          AND c.ts BETWEEN ? AND ?
        GROUP BY cf.file_path
        ORDER BY churn DESC
        LIMIT ?
    """, [repo_id, email, ts_from, ts_to, top_n]).fetchall()
    con.close()

    return [
        {
            "file_path": r[0], "churn": r[1], "touches": r[2],
            "first_touch": r[3], "last_touch": r[4],
        }
        for r in rows
    ]


# ─────────────────────────────────────────────
# /api/bridge_commits  — 某人的跨模块胶水 commit
# ─────────────────────────────────────────────
@app.get("/api/bridge_commits")
def get_bridge_commits(
    repo_id: str,
    email: str,
    ts_from: int = Query(0),
    ts_to:   int = Query(9999999999),
    min_modules: int = Query(2, description="Min distinct top-level dirs per commit"),
):
    con = get_con()
    rows = con.execute("""
        SELECT
            c.hash,
            c.message,
            c.ts,
            COUNT(DISTINCT split_part(cf.file_path, '/', 1)) AS module_count,
            LIST(DISTINCT split_part(cf.file_path, '/', 1))  AS modules
        FROM commits c
        JOIN commit_files cf ON c.hash = cf.hash AND c.repo_id = cf.repo_id
        WHERE c.repo_id = ?
          AND c.author_email = ?
          AND c.ts BETWEEN ? AND ?
        GROUP BY c.hash, c.message, c.ts
        HAVING module_count >= ?
        ORDER BY module_count DESC, c.ts DESC
        LIMIT 50
    """, [repo_id, email, ts_from, ts_to, min_modules]).fetchall()
    con.close()

    return [
        {
            "hash": r[0], "message": r[1], "ts": r[2],
            "module_count": r[3], "modules": r[4],
        }
        for r in rows
    ]


# ─────────────────────────────────────────────
# /api/island_risk  — 孤岛风险（只有 1 人提交的模块）
# ─────────────────────────────────────────────
@app.get("/api/island_risk")
def get_island_risk(
    repo_id: str,
    ts_from: int = Query(0),
    ts_to:   int = Query(9999999999),
):
    con = get_con()
    rows = con.execute("""
        SELECT
            cf.file_path,
            COUNT(DISTINCT c.author_email) AS author_count,
            SUM(cf.additions + cf.deletions) AS churn,
            MIN(c.author_email) AS sole_author
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        WHERE cf.repo_id = ?
          AND c.ts BETWEEN ? AND ?
        GROUP BY cf.file_path
        HAVING author_count = 1
        ORDER BY churn DESC
        LIMIT 100
    """, [repo_id, ts_from, ts_to]).fetchall()
    con.close()

    return [
        {
            "file_path": r[0], "author_count": r[1],
            "churn": r[2], "sole_author": r[3],
        }
        for r in rows
    ]


# ─────────────────────────────────────────────
# /api/forgotten  — 遗忘代码（长期无人提交）
# ─────────────────────────────────────────────
@app.get("/api/forgotten")
def get_forgotten(
    repo_id: str,
    days_threshold: int = Query(180, description="Days without commit"),
):
    import time
    cutoff = int(time.time()) - days_threshold * 86400
    con = get_con()
    rows = con.execute("""
        SELECT
            cf.file_path,
            MAX(c.ts) AS last_commit_ts,
            COUNT(DISTINCT c.author_email) AS author_count
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        WHERE cf.repo_id = ?
        GROUP BY cf.file_path
        HAVING last_commit_ts < ?
        ORDER BY last_commit_ts ASC
        LIMIT 100
    """, [repo_id, cutoff]).fetchall()
    con.close()

    return [
        {
            "file_path": r[0], "last_commit_ts": r[1], "author_count": r[2],
            "days_ago": int((int(__import__('time').time()) - r[1]) / 86400),
        }
        for r in rows
    ]


# ─────────────────────────────────────────────
# /api/author_context  — 供 Agent / Skill 调用的纯上下文数据
# 不含规则标签、不含 LLM 调用，仅返回原始结构化特征
# ─────────────────────────────────────────────
@app.get("/api/author_context")
def get_author_context(repo_id: str, email: str):
    """
    机器可读的作者上下文数据，供外部 Agent 或 Skill 使用。
    返回字段比 /api/author_profile 更原始，不含规则标签，便于 LLM 自行推理。
    """
    con = get_con()
    profile = build_profile(con, repo_id, email)
    con.close()
    if not profile:
        raise HTTPException(status_code=404, detail="Author not found")

    d = profile_to_dict(profile)
    # 移除规则引擎已做的解读，让 Agent 自行推理
    return {
        "meta": {
            "repo_id": repo_id,
            "email": d["email"],
            "name": d["name"],
            "username": d["username"],
        },
        "activity": {
            "first_commit_ts": d["first_commit_ts"],
            "last_commit_ts": d["last_commit_ts"],
            "active_months": d["active_months"],
            "total_months": d["total_months"],
            "consistency_score": d["consistency_score"],
        },
        "volume": {
            "total_commits": d["total_commits"],
            "total_churn": d["total_churn"],
            "avg_churn_per_commit": d["avg_churn_per_commit"],
            "total_files_touched": d["total_files_touched"],
            "solo_owned_files": d["solo_owned_files"],
        },
        "modules": {
            "module_count": d["module_count"],
            "concentration": d["concentration"],
            "top_modules": d["top_modules"],
        },
        "bridge": {
            "bridge_commit_count": d["bridge_commit_count"],
            "bridge_ratio": d["bridge_ratio"],
            "most_bridged_modules": d["most_bridged_modules"],
        },
        "collaboration": {
            "collab_partners": d["collab_partners"],
        },
        "commit_samples": {
            "recent_messages": d["recent_messages"],
        },
        # 规则引擎结果保留作参考，但 Agent 可自行判断
        "rule_hint": {
            "role_tags": d["role_tags"],
            "role_summary": d["role_summary"],
        },
    }


# ─────────────────────────────────────────────
# /api/author_profile  — 某人的完整行为画像（结构化数据）
# ─────────────────────────────────────────────
@app.get("/api/author_profile")
def get_author_profile(repo_id: str, email: str):
    con = get_con()
    profile = build_profile(con, repo_id, email)
    con.close()
    if not profile:
        raise HTTPException(status_code=404, detail="Author not found")
    return profile_to_dict(profile)


# ─────────────────────────────────────────────
# /api/author_ai_profile  — LLM 流式生成角色分析
# 需要环境变量 OPENAI_API_KEY 或 VISUALREPO_LLM_KEY
# 未配置时退化到规则摘要
# ─────────────────────────────────────────────
@app.get("/api/author_ai_profile")
async def get_author_ai_profile(repo_id: str, email: str):
    con = get_con()

    # 同时取仓库名
    repo_row = con.execute(
        "SELECT name FROM repos WHERE repo_id=?", [repo_id]
    ).fetchone()
    repo_name = repo_row[0] if repo_row else repo_id

    profile = build_profile(con, repo_id, email)
    con.close()

    if not profile:
        raise HTTPException(status_code=404, detail="Author not found")

    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("VISUALREPO_LLM_KEY", "")

    if not api_key:
        # 无 LLM key，返回规则摘要（非流式）
        async def fallback_stream():
            data = {
                "type": "rule_based",
                "role_tags": profile.role_tags,
                "summary": profile.role_summary,
                "note": "未配置 LLM Key，以下为规则引擎摘要。设置环境变量 OPENAI_API_KEY 可启用 AI 深度分析。",
            }
            yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(fallback_stream(), media_type="text/event-stream")

    prompt = build_llm_prompt(profile, repo_name)

    async def llm_stream():
        try:
            import httpx
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            llm_base = os.environ.get("VISUALREPO_LLM_BASE", "https://api.openai.com")
            llm_model = os.environ.get("VISUALREPO_LLM_MODEL", "gpt-4o-mini")
            payload = {
                "model": llm_model,
                "stream": True,
                "messages": [
                    {"role": "system", "content": "你是一名专业的工程效能分析师，擅长从 Git 数据中洞察工程师的工作模式和团队角色。"},
                    {"role": "user", "content": prompt},
                ],
            }
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    f"{llm_base}/v1/chat/completions",
                    headers=headers,
                    json=payload,
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            chunk = line[6:]
                            if chunk == "[DONE]":
                                yield "data: [DONE]\n\n"
                                break
                            try:
                                obj = json.loads(chunk)
                                delta = obj["choices"][0]["delta"].get("content", "")
                                if delta:
                                    yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
                            except Exception:
                                pass
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(llm_stream(), media_type="text/event-stream")


# ─────────────────────────────────────────────
# 静态资源服务（包内置的预构建前端，由 scripts/build_frontend.sh 生成）
# ─────────────────────────────────────────────
_web_dir = Path(__file__).parent / "web"
if _web_dir.exists():
    app.mount("/", StaticFiles(directory=str(_web_dir), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("visualrepo.app:app", host="0.0.0.0", port=7842, reload=True)
