"""
author_profiler.py — 从 DuckDB 中提取某人的行为特征，生成结构化画像数据。
供规则引擎标注角色、以及向 LLM 格式化 prompt 使用。
"""

from __future__ import annotations
import time
from dataclasses import dataclass, field
from typing import Optional
import duckdb


# ─────────────────────────────────────────────────────────────
# 数据结构
# ─────────────────────────────────────────────────────────────

@dataclass
class ModuleStat:
    name: str
    churn: int
    touches: int
    pct: float          # 该模块占此人总 churn 的比例


@dataclass
class CollabPartner:
    email: str
    name: str
    username: str
    shared_files: int   # 双方都修改过的文件数
    overlap_pct: float  # 重叠文件占此人总文件的百分比


@dataclass
class AuthorProfile:
    email: str
    name: str
    username: str

    # 活跃时间窗口
    first_commit_ts: int
    last_commit_ts: int
    active_months: int          # 有 commit 的月份数
    total_months: int           # 从第一次到最后一次 commit 的总月份数
    consistency_score: float    # active_months / total_months，越接近 1 越稳定

    # 提交量统计
    total_commits: int
    total_churn: int
    avg_churn_per_commit: float
    total_files_touched: int
    solo_owned_files: int       # 只有此人提交过的文件数（排他所有权）

    # 模块分布
    top_modules: list[ModuleStat]           # 按 churn 降序，top-5
    module_count: int                       # 触及的顶层目录数
    concentration: float                    # top-1 模块占总 churn 的比例（越高越专)

    # 跨模块桥接
    bridge_commit_count: int               # 触及 ≥2 个顶层模块的 commit 数
    bridge_ratio: float                    # bridge_commit_count / total_commits
    most_bridged_modules: list[str]        # 最常一起出现的模块对

    # 协作关系
    collab_partners: list[CollabPartner]   # 重叠最多的合作者，top-5

    # commit message 样本（供 LLM 理解工作内容）
    recent_messages: list[str]             # 最近 20 条 commit message

    # 规则引擎标注的角色标签（可多个）
    role_tags: list[str] = field(default_factory=list)
    role_summary: str = ""                  # 规则引擎生成的一句话描述


# ─────────────────────────────────────────────────────────────
# 核心计算
# ─────────────────────────────────────────────────────────────

def build_profile(con: duckdb.DuckDBPyConnection, repo_id: str, email: str) -> Optional[AuthorProfile]:
    # 基本信息
    row = con.execute(
        "SELECT name, username FROM authors WHERE repo_id=? AND email=?",
        [repo_id, email]
    ).fetchone()
    if not row:
        return None
    name, username = row

    # 活跃时间
    time_row = con.execute("""
        SELECT MIN(ts), MAX(ts), COUNT(*),
               COUNT(DISTINCT strftime(to_timestamp(ts), '%Y-%m'))
        FROM commits
        WHERE repo_id=? AND author_email=?
    """, [repo_id, email]).fetchone()
    first_ts, last_ts, total_commits, active_months = time_row

    span_months = max(1, int((last_ts - first_ts) / (86400 * 30)))
    consistency = round(min(1.0, active_months / span_months), 2)

    # 文件 churn 统计
    churn_row = con.execute("""
        SELECT SUM(cf.additions + cf.deletions), COUNT(DISTINCT cf.file_path)
        FROM commit_files cf
        JOIN commits c ON cf.hash=c.hash AND cf.repo_id=c.repo_id
        WHERE cf.repo_id=? AND c.author_email=?
    """, [repo_id, email]).fetchone()
    total_churn = churn_row[0] or 0
    total_files = churn_row[1] or 0

    avg_churn = round(total_churn / max(1, total_commits), 1)

    # 独占文件数（只有此人提交过的文件）
    solo_row = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT cf.file_path
            FROM commit_files cf
            JOIN commits c ON cf.hash=c.hash AND cf.repo_id=c.repo_id
            WHERE cf.repo_id=?
            GROUP BY cf.file_path
            HAVING COUNT(DISTINCT c.author_email) = 1
               AND MIN(c.author_email) = ?
        )
    """, [repo_id, email]).fetchone()
    solo_owned = solo_row[0] or 0

    # 模块分布（顶层目录）——一次取全部分组，top-5 与总数共用
    module_rows = con.execute("""
        SELECT
            split_part(cf.file_path, '/', 1) AS module,
            SUM(cf.additions + cf.deletions) AS churn,
            COUNT(DISTINCT cf.file_path)      AS touches
        FROM commit_files cf
        JOIN commits c ON cf.hash=c.hash AND cf.repo_id=c.repo_id
        WHERE cf.repo_id=? AND c.author_email=?
        GROUP BY module
        ORDER BY churn DESC
    """, [repo_id, email]).fetchall()

    top_modules = [
        ModuleStat(
            name=r[0], churn=r[1], touches=r[2],
            pct=round(r[1] / max(1, total_churn) * 100, 1)
        )
        for r in module_rows[:5]
    ]
    module_count = len(module_rows)
    concentration = top_modules[0].pct / 100 if top_modules else 0.0

    # 桥接 commit
    bridge_row = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT c.hash
            FROM commits c
            JOIN commit_files cf ON c.hash=cf.hash AND c.repo_id=cf.repo_id
            WHERE c.repo_id=? AND c.author_email=?
            GROUP BY c.hash
            HAVING COUNT(DISTINCT split_part(cf.file_path, '/', 1)) >= 2
        )
    """, [repo_id, email]).fetchone()
    bridge_count = bridge_row[0] or 0
    bridge_ratio = round(bridge_count / max(1, total_commits), 2)

    # 最常桥接的模块对
    bridge_pair_rows = con.execute("""
        SELECT
            split_part(cf.file_path, '/', 1) AS mod
        FROM commits c
        JOIN commit_files cf ON c.hash=cf.hash AND c.repo_id=cf.repo_id
        WHERE c.repo_id=? AND c.author_email=?
        GROUP BY c.hash, mod
        HAVING COUNT(DISTINCT split_part(cf.file_path, '/', 1)) >= 2
    """, [repo_id, email]).fetchall()
    # 简化：取出现最多的 3 个模块
    from collections import Counter
    bridge_mods = Counter(r[0] for r in bridge_pair_rows)
    most_bridged = [m for m, _ in bridge_mods.most_common(3)]

    # 协作伙伴（共同修改过最多文件）
    collab_rows = con.execute("""
        SELECT
            c2.author_email,
            a.name,
            a.username,
            COUNT(DISTINCT cf1.file_path) AS shared_files
        FROM commit_files cf1
        JOIN commits c1 ON cf1.hash=c1.hash AND cf1.repo_id=c1.repo_id
        JOIN commit_files cf2 ON cf1.file_path=cf2.file_path AND cf1.repo_id=cf2.repo_id
        JOIN commits c2 ON cf2.hash=c2.hash AND cf2.repo_id=c2.repo_id
        JOIN authors a ON c2.author_email=a.email AND a.repo_id=cf1.repo_id
        WHERE cf1.repo_id=?
          AND c1.author_email=?
          AND c2.author_email != ?
        GROUP BY c2.author_email, a.name, a.username
        ORDER BY shared_files DESC
        LIMIT 5
    """, [repo_id, email, email]).fetchall()

    collab_partners = [
        CollabPartner(
            email=r[0], name=r[1], username=r[2],
            shared_files=r[3],
            overlap_pct=round(r[3] / max(1, total_files) * 100, 1)
        )
        for r in collab_rows
    ]

    # 全量 commit messages（按 ts 降序，前 25 条即近期样本）
    all_msg_rows = con.execute("""
        SELECT message FROM commits
        WHERE repo_id=? AND author_email=?
        ORDER BY ts DESC
    """, [repo_id, email]).fetchall()
    recent_messages = [r[0] for r in all_msg_rows[:25] if r[0].strip()][:20]

    # 提交时间分布（夜猫子 / 早鸟检测，UTC+8 近似）
    hour_rows = con.execute("""
        SELECT (CAST(ts AS BIGINT) % 86400 + 28800) % 86400 / 3600 AS local_hour,
               COUNT(*) AS cnt
        FROM commits
        WHERE repo_id=? AND author_email=?
        GROUP BY local_hour
    """, [repo_id, email]).fetchall()
    hour_dist = {int(r[0]): int(r[1]) for r in hour_rows}
    total_h = max(1, sum(hour_dist.values()))
    night_ratio = sum(v for h, v in hour_dist.items() if h >= 22 or h < 5) / total_h
    early_ratio = sum(v for h, v in hour_dist.items() if 5 <= h < 9) / total_h

    # 提交 message 关键词统计（全量）
    import re as _re
    all_msgs = [r[0] or "" for r in all_msg_rows]
    total_msgs = max(1, len(all_msgs))
    fix_ratio     = sum(1 for m in all_msgs if _re.search(r'\bfix\b|bugfix|hotfix|\bbug\b|修复', m, _re.I)) / total_msgs
    feat_ratio    = sum(1 for m in all_msgs if _re.search(r'\bfeat\b|feature|\badd\b|新增|新功能|支持', m, _re.I)) / total_msgs
    refactor_ratio= sum(1 for m in all_msgs if _re.search(r'refactor|clean|lint|\bstyle\b|整理|重构|优化', m, _re.I)) / total_msgs

    # 在仓库中的提交量排名
    rank_row = con.execute("""
        SELECT COUNT(*) FROM authors WHERE repo_id=? AND commit_count > ?
    """, [repo_id, total_commits]).fetchone()
    commit_rank = (rank_row[0] or 0) + 1

    profile = AuthorProfile(
        email=email,
        name=name,
        username=username,
        first_commit_ts=first_ts,
        last_commit_ts=last_ts,
        active_months=active_months,
        total_months=span_months,
        consistency_score=consistency,
        total_commits=total_commits,
        total_churn=total_churn,
        avg_churn_per_commit=avg_churn,
        total_files_touched=total_files,
        solo_owned_files=solo_owned,
        top_modules=top_modules,
        module_count=module_count,
        concentration=concentration,
        bridge_commit_count=bridge_count,
        bridge_ratio=bridge_ratio,
        most_bridged_modules=most_bridged,
        collab_partners=collab_partners,
        recent_messages=recent_messages,
    )

    _apply_role_tags(profile, commit_rank=commit_rank,
                     fix_ratio=fix_ratio, feat_ratio=feat_ratio,
                     refactor_ratio=refactor_ratio,
                     night_ratio=night_ratio, early_ratio=early_ratio)
    return profile


# ─────────────────────────────────────────────────────────────
# 规则引擎：打角色标签
# ─────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────
# 规则引擎：打角色标签（趣味标签体系，不生成一句话摘要）
# ─────────────────────────────────────────────────────────────

def _apply_role_tags(
    p: AuthorProfile,
    commit_rank: int = 99,
    fix_ratio: float = 0.0,
    feat_ratio: float = 0.0,
    refactor_ratio: float = 0.0,
    night_ratio: float = 0.0,
    early_ratio: float = 0.0,
):
    tags: list[str] = []

    # ── 贡献量 ──────────────────────────────────────────────
    if commit_rank == 1:
        tags.append("🏆 贡献 MVP")
    elif commit_rank <= 3:
        tags.append("🥇 Top 贡献者")
    elif commit_rank <= 10:
        tags.append("⭐ 活跃核心")

    # ── 领域 vs 全栈 ────────────────────────────────────────
    if p.concentration >= 0.65 and p.module_count <= 3:
        tags.append("🏰 领域守护者")
    elif p.module_count >= 6 and p.concentration < 0.4:
        tags.append("🌐 全栈游侠")

    # ── 胶水 / 桥梁 ─────────────────────────────────────────
    if p.bridge_ratio >= 0.35:
        tags.append("🌉 胶水大王")
    elif p.bridge_ratio >= 0.2:
        tags.append("🔗 模块摆渡人")

    # ── 代码所有权 ──────────────────────────────────────────
    solo_ratio = p.solo_owned_files / max(1, p.total_files_touched)
    if solo_ratio >= 0.6 and p.total_files_touched >= 10:
        tags.append("👑 代码领主")
    elif p.solo_owned_files >= 30:
        tags.append("🗺 独立王国")

    # ── 提交风格 ────────────────────────────────────────────
    if p.avg_churn_per_commit >= 300:
        tags.append("🚀 大刀阔斧")
    elif p.avg_churn_per_commit >= 150:
        tags.append("⚡ 雷厉风行")
    elif p.avg_churn_per_commit <= 15 and p.total_commits >= 30:
        tags.append("🔬 精雕细琢")

    # ── commit message 风格 ─────────────────────────────────
    if fix_ratio >= 0.4:
        tags.append("🐛 Fix 之神")
    elif fix_ratio >= 0.25:
        tags.append("🔧 救火队员")
    if feat_ratio >= 0.4:
        tags.append("🌱 功能先锋")
    if refactor_ratio >= 0.25:
        tags.append("✨ 代码洁癖")

    # ── 持续性 ──────────────────────────────────────────────
    if p.consistency_score >= 0.85 and p.total_months >= 6:
        tags.append("📅 常青贡献者")
    elif p.consistency_score < 0.25 and p.total_commits >= 20:
        tags.append("🌊 集中冲刺型")

    # ── 作息特征 ────────────────────────────────────────────
    if night_ratio >= 0.25:
        tags.append("🦉 熬夜能手")
    elif early_ratio >= 0.25:
        tags.append("🐓 早起打工人")

    # ── 兜底 ────────────────────────────────────────────────
    if not tags:
        tags.append("🔧 稳定贡献者")

    p.role_tags = tags
    p.role_summary = ""   # 不再生成一句话摘要


# ─────────────────────────────────────────────────────────────
# 生成 LLM prompt
# ─────────────────────────────────────────────────────────────

def build_llm_prompt(p: AuthorProfile, repo_name: str) -> str:
    mod_lines = "\n".join(
        f"  - {m.name}: {m.churn} 行变动，触及 {m.touches} 个文件 ({m.pct:.1f}%)"
        for m in p.top_modules
    )
    partner_lines = "\n".join(
        f"  - {c.name}（{c.email}）：共同修改过 {c.shared_files} 个文件"
        for c in p.collab_partners[:3]
    )
    msg_sample = "\n".join(f"  · {m}" for m in p.recent_messages[:15])

    return f"""你是一名资深工程效能分析师。请根据以下 Git commit 数据，对工程师 {p.name}（{p.email}）在仓库 {repo_name} 中的角色进行深度画像分析。

## 基础统计
- 总 commit 数：{p.total_commits}
- 累计代码变动行数：{p.total_churn}（平均每 commit {p.avg_churn_per_commit:.0f} 行）
- 触及文件数：{p.total_files_touched}，其中独占 {p.solo_owned_files} 个
- 活跃时间：{p.active_months} 个月活跃 / 共跨越 {p.total_months} 个月（持续性 {p.consistency_score*100:.0f}%）

## 模块分布（Top {len(p.top_modules)}）
{mod_lines}
- 最高浓度模块占比：{p.concentration*100:.1f}%，共触及 {p.module_count} 个顶层模块

## 跨模块行为
- 跨模块 commit（胶水工作）：{p.bridge_commit_count} 次（占总 commit {p.bridge_ratio*100:.1f}%）
- 常见桥接模块：{', '.join(p.most_bridged_modules) if p.most_bridged_modules else '无'}

## 主要协作伙伴
{partner_lines if partner_lines else '  暂无数据'}

## 近期 commit message 样本（反映工作内容）
{msg_sample}

## 规则引擎预判角色标签
{', '.join(p.role_tags)}

---

请完成以下分析，用中文回答，分三段：

1. **角色定位**（2-3 句）：这个人在团队中扮演什么角色？是领域专家、架构桥梁、基础设施守护者还是其他？结合数据给出判断。

2. **工作特征**（3-4 句）：他/她的工作风格和技术倾向是什么？commit 内容说明了什么？有哪些值得关注的模式（比如频繁大改动、持续精细调整、集中在某个功能方向等）？

3. **潜在风险与洞察**（2-3 句）：这个人的贡献模式有哪些值得团队关注的地方？比如知识孤岛风险、过度依赖、或者难得的跨领域架构视野？

语气专业客观，避免空话，每个判断都需要有数据支撑。"""


# ─────────────────────────────────────────────────────────────
# 序列化（供 API 返回）
# ─────────────────────────────────────────────────────────────

def profile_to_dict(p: AuthorProfile) -> dict:
    return {
        "email": p.email,
        "name": p.name,
        "username": p.username,
        "first_commit_ts": p.first_commit_ts,
        "last_commit_ts": p.last_commit_ts,
        "active_months": p.active_months,
        "total_months": p.total_months,
        "consistency_score": p.consistency_score,
        "total_commits": p.total_commits,
        "total_churn": p.total_churn,
        "avg_churn_per_commit": p.avg_churn_per_commit,
        "total_files_touched": p.total_files_touched,
        "solo_owned_files": p.solo_owned_files,
        "module_count": p.module_count,
        "concentration": p.concentration,
        "bridge_commit_count": p.bridge_commit_count,
        "bridge_ratio": p.bridge_ratio,
        "most_bridged_modules": p.most_bridged_modules,
        "top_modules": [
            {"name": m.name, "churn": m.churn, "touches": m.touches, "pct": m.pct}
            for m in p.top_modules
        ],
        "collab_partners": [
            {
                "email": c.email, "name": c.name, "username": c.username,
                "shared_files": c.shared_files, "overlap_pct": c.overlap_pct,
            }
            for c in p.collab_partners
        ],
        "recent_messages": p.recent_messages,
        "role_tags": p.role_tags,
        "role_summary": p.role_summary,
    }
