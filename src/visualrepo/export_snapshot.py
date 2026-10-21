"""
export_snapshot.py — 把一个已索引仓库的数据导出成一组静态 JSON 文件，
供无后端环境（GitHub Pages / Vercel 静态托管）部署只读 demo 使用。

采样策略：
- files: 全历史 churn 最高的 top_files 个文件（与 /api/treemap 的 MAX_LEAVES 同一思路）
- authors: commit 数最高的 top_authors 个贡献者，其余归入 "_other" 桶
- cells: 按「文件 × 作者 × 月」粒度的稀疏聚合，供前端在浏览器里按任意时间窗口/作者
  筛选重新聚合出 treemap（无需后端实时查询）
- author_profile: 对 top profile 作者数复用 author_profiler 的真实逻辑，预渲染成 JSON
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb

from visualrepo.author_profiler import build_profile, profile_to_dict

OTHER_KEY = "_other"


def export_snapshot(
    db_path: str,
    repo_id: str,
    out_dir: str,
    top_files: int = 1500,
    top_authors: int = 60,
    top_profiles: int = 30,
) -> dict:
    con = duckdb.connect(db_path, read_only=True)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    repo_row = con.execute(
        "SELECT name, indexed_at FROM repos WHERE repo_id=?", [repo_id]
    ).fetchone()
    if not repo_row:
        con.close()
        raise ValueError(f"repo_id 不存在：{repo_id}")
    repo_name, indexed_at = repo_row

    total_commits = con.execute(
        "SELECT COUNT(*) FROM commits WHERE repo_id=?", [repo_id]
    ).fetchone()[0]
    total_authors = con.execute(
        "SELECT COUNT(*) FROM authors WHERE repo_id=?", [repo_id]
    ).fetchone()[0]
    total_files = con.execute(
        "SELECT COUNT(DISTINCT file_path) FROM commit_files WHERE repo_id=?", [repo_id]
    ).fetchone()[0]

    # 个别 commit 的 author 时间戳可能因 rebase / 时钟错误离谱地早或晚（见过 1996、2077
    # 这类假日期），少量离群点会把月度时间轴拉得异常长。按 0.5% 分位裁掉两端离群点，
    # 不影响真实历史密度。
    ts_lo, ts_hi = con.execute(
        """
        SELECT quantile_cont(ts, 0.005), quantile_cont(ts, 0.995)
        FROM commits WHERE repo_id = ?
        """,
        [repo_id],
    ).fetchone()
    ts_filter = "AND c.ts BETWEEN ? AND ?"
    ts_params = [ts_lo, ts_hi]

    # ── top authors（含被截断的其余贡献者汇总）──────────────────────
    author_rows = con.execute(
        """
        SELECT email, name, username, commit_count
        FROM authors WHERE repo_id=?
        ORDER BY commit_count DESC
        """,
        [repo_id],
    ).fetchall()
    kept_authors = author_rows[:top_authors]
    author_index = {email: i for i, (email, *_rest) in enumerate(kept_authors)}
    authors_json = [
        {"email": e, "name": n, "username": u, "commit_count": c}
        for e, n, u, c in kept_authors
    ]

    # ── top files（全历史 churn 排序）──────────────────────────────
    file_rows = con.execute(
        """
        SELECT cf.file_path, SUM(cf.additions + cf.deletions) AS churn
        FROM commit_files cf
        WHERE cf.repo_id = ?
        GROUP BY cf.file_path
        ORDER BY churn DESC
        LIMIT ?
        """,
        [repo_id, top_files],
    ).fetchall()
    file_index = {path: i for i, (path, _churn) in enumerate(file_rows)}
    files_json = [path for path, _churn in file_rows]

    # ── months 索引（覆盖全历史，不受采样影响，但裁掉离群时间戳）────
    month_rows = con.execute(
        f"""
        SELECT DISTINCT strftime(to_timestamp(ts), '%Y-%m') AS month
        FROM commits c WHERE repo_id = ? {ts_filter}
        ORDER BY month
        """,
        [repo_id, *ts_params],
    ).fetchall()
    months_json = [m for (m,) in month_rows]
    month_index = {m: i for i, m in enumerate(months_json)}

    # ── cells：file × author × month 粒度 churn/touches（仅 top_files ∩ top_authors）
    placeholders_f = ",".join(["?"] * len(files_json)) if files_json else "NULL"
    cell_rows = con.execute(
        f"""
        SELECT
            cf.file_path,
            c.author_email,
            strftime(to_timestamp(c.ts), '%Y-%m') AS month,
            SUM(cf.additions + cf.deletions) AS churn,
            COUNT(*) AS touches
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        WHERE cf.repo_id = ?
          AND cf.file_path IN ({placeholders_f})
          {ts_filter}
        GROUP BY cf.file_path, c.author_email, month
        """,
        [repo_id, *files_json, *ts_params],
    ).fetchall()

    cells_json = []
    for file_path, email, month, churn, touches in cell_rows:
        if file_path not in file_index or month not in month_index:
            continue
        a_idx = author_index.get(email)
        if a_idx is None:
            continue  # 非 top 作者的 churn 不计入 cells（仅用于前端按作者高亮/筛选）
        cells_json.append([file_index[file_path], a_idx, month_index[month], int(churn), int(touches)])

    # ── loc_cells：file × month 的净行数变化（不分作者，用于 loc 模式总面积）────
    loc_rows = con.execute(
        f"""
        SELECT
            cf.file_path,
            strftime(to_timestamp(c.ts), '%Y-%m') AS month,
            SUM(cf.additions) - SUM(cf.deletions) AS net
        FROM commit_files cf
        JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
        WHERE cf.repo_id = ?
          AND cf.file_path IN ({placeholders_f})
          {ts_filter}
        GROUP BY cf.file_path, month
        """,
        [repo_id, *files_json, *ts_params],
    ).fetchall()
    loc_cells_json = [
        [file_index[fp], month_index[m], int(net)]
        for fp, m, net in loc_rows
        if fp in file_index and m in month_index
    ]

    # ── timeline：精确（不采样）月度 commit 总数，作者维度仅保留 top_authors + _other
    timeline_rows = con.execute(
        f"""
        SELECT strftime(to_timestamp(ts), '%Y-%m') AS month, author_email, COUNT(*) AS cnt
        FROM commits c WHERE repo_id = ? {ts_filter}
        GROUP BY month, author_email
        ORDER BY month
        """,
        [repo_id, *ts_params],
    ).fetchall()
    timeline_map: dict[str, dict] = {}
    for month, email, cnt in timeline_rows:
        bucket = timeline_map.setdefault(month, {"month": month, "total": 0, "by_author": {}})
        bucket["total"] += cnt
        key = email if email in author_index else OTHER_KEY
        bucket["by_author"][key] = bucket["by_author"].get(key, 0) + cnt
    timeline_json = sorted(timeline_map.values(), key=lambda x: x["month"])

    # ── 预渲染 top_profiles 位作者的完整画像（复用真实规则引擎，非采样数据）──
    profiles_json: dict[str, dict] = {}
    for email, *_rest in kept_authors[:top_profiles]:
        profile = build_profile(con, repo_id, email)
        if profile:
            profiles_json[email] = profile_to_dict(profile)

    con.close()

    meta_json = {
        "repo_id": repo_id,
        "name": repo_name,
        "indexed_at": indexed_at,
        "sampled": True,
        "real_totals": {
            "commits": total_commits,
            "authors": total_authors,
            "files": total_files,
        },
        "sample_sizes": {
            "files": len(files_json),
            "authors": len(authors_json),
            "profiles": len(profiles_json),
        },
    }

    _write_json(out / "meta.json", meta_json)
    _write_json(out / "authors.json", authors_json)
    _write_json(out / "files.json", files_json)
    _write_json(out / "months.json", months_json)
    _write_json(out / "cells.json", cells_json)
    _write_json(out / "loc_cells.json", loc_cells_json)
    _write_json(out / "timeline.json", timeline_json)
    _write_json(out / "profiles.json", profiles_json)

    return meta_json


def _write_json(path: Path, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
