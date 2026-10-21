"""
git_ingest.py — 从 Git 仓库提取 commit 数据，写入 DuckDB
支持全量初始化和增量更新，支持直接传入远程 git 地址（自动 clone/pull 到本地缓存）
"""

import subprocess
import os
import re
import csv
import hashlib
import tempfile
from pathlib import Path
from datetime import datetime
from typing import Optional
import duckdb

from visualrepo.paths import repos_dir

# 需要过滤掉的文件类型（非代码产物）
SKIP_EXTENSIONS = {
    ".md", ".txt", ".lock", ".sum", ".mod",
    ".gitignore", ".gitattributes", ".editorconfig",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".json",  # 通常是配置，按需开启
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
    ".mp4", ".mov", ".zip", ".tar", ".gz",
    ".pb", ".bin", ".onnx", ".pt", ".pkl",
    ".flags",  # bazel flags 文件
}

CODE_EXTENSIONS = {
    ".py", ".java", ".kt", ".go", ".ts", ".tsx", ".js", ".jsx",
    ".cpp", ".cc", ".c", ".h", ".hpp",
    ".rs", ".scala", ".rb", ".php", ".swift",
    ".sh", ".bash",
}


def run_git(args: list[str], cwd: str) -> str:
    result = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr[:200]}")
    return result.stdout


def is_git_url(target: str) -> bool:
    """判断传入的 target 是远程 git 地址还是本地路径"""
    return (
        target.startswith(("http://", "https://", "git@", "ssh://"))
        or target.endswith(".git")
    )


def resolve_target(target: str) -> Path:
    """
    把用户传入的 target（git 地址或本地路径）解析为一个本地可用的 git 仓库目录。
    - 远程地址：clone 到 ~/.visualrepo/repos/<id>（已存在则 git pull）
    - 本地路径：原样展开 & 校验存在
    """
    if is_git_url(target):
        repo_cache_id = hashlib.md5(target.encode()).hexdigest()[:12]
        dest = repos_dir() / repo_cache_id
        if dest.exists():
            try:
                run_git(["pull", "--ff-only"], str(dest))
            except Exception:
                pass  # 拉取失败不阻断，用已有的本地副本继续
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "clone", target, str(dest)],
                check=True,
            )
        return dest

    local = Path(target).expanduser().resolve()
    if not local.exists():
        raise FileNotFoundError(f"路径不存在：{local}")
    return local


def get_repo_id(repo_path: str) -> str:
    """用仓库远端 URL 或路径 hash 作为唯一 ID"""
    try:
        remote = run_git(["remote", "get-url", "origin"], repo_path).strip()
        return hashlib.md5(remote.encode()).hexdigest()[:12]
    except Exception:
        return hashlib.md5(os.path.abspath(repo_path).encode()).hexdigest()[:12]


def get_repo_name(repo_path: str) -> str:
    try:
        remote = run_git(["remote", "get-url", "origin"], repo_path).strip()
        return remote.rstrip("/").split("/")[-1].removesuffix(".git")
    except Exception:
        return Path(repo_path).name


def parse_git_log(repo_path: str, since_hash: Optional[str] = None) -> list[dict]:
    """
    解析 git log，返回 commit 列表。
    每个 commit: {hash, author_email, author_name, ts, message, files: [{path, add, del}]}
    """
    sep = "|||COMMIT|||"
    fmt = f"%H{sep}%ae{sep}%an{sep}%at{sep}%s"

    args = ["log", f"--format={fmt}", "--numstat", "--no-merges"]
    if since_hash:
        args.append(f"{since_hash}..HEAD")

    raw = run_git(args, repo_path)

    commits = []
    current = None

    for line in raw.splitlines():
        if sep in line:
            if current:
                commits.append(current)
            parts = line.split(sep)
            if len(parts) == 5:
                current = {
                    "hash": parts[0].strip(),
                    "author_email": parts[1].strip().lower(),
                    "author_name": parts[2].strip(),
                    "ts": int(parts[3].strip()),
                    "message": parts[4].strip(),
                    "files": [],
                }
        elif current and line.strip():
            # numstat 行格式：add\tdel\tpath
            m = re.match(r"^(\d+|-)\t(\d+|-)\t(.+)$", line.strip())
            if m:
                add_s, del_s, path = m.groups()
                add = int(add_s) if add_s != "-" else 0
                dele = int(del_s) if del_s != "-" else 0
                ext = Path(path).suffix.lower()
                # 只保留代码文件（或未知扩展名）
                if ext not in SKIP_EXTENSIONS:
                    current["files"].append({
                        "path": path,
                        "add": add,
                        "del": dele,
                    })

    if current:
        commits.append(current)

    return commits


def init_db(db_path: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(db_path)
    con.execute("""
        CREATE TABLE IF NOT EXISTS repos (
            repo_id      VARCHAR PRIMARY KEY,
            name         VARCHAR,
            path         VARCHAR,
            last_hash    VARCHAR,
            indexed_at   BIGINT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS commits (
            hash         VARCHAR,
            repo_id      VARCHAR,
            author_email VARCHAR,
            author_name  VARCHAR,
            ts           BIGINT,
            message      VARCHAR,
            PRIMARY KEY (hash, repo_id)
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS commit_files (
            hash         VARCHAR,
            repo_id      VARCHAR,
            file_path    VARCHAR,
            additions    INTEGER,
            deletions    INTEGER
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS authors (
            email        VARCHAR,
            repo_id      VARCHAR,
            name         VARCHAR,
            username     VARCHAR,
            commit_count INTEGER DEFAULT 0,
            PRIMARY KEY (email, repo_id)
        )
    """)
    # 加速查询的索引
    try:
        con.execute("CREATE INDEX IF NOT EXISTS idx_cf_repo_path ON commit_files(repo_id, file_path)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_commits_ts ON commits(repo_id, ts)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(repo_id, author_email)")
    except Exception:
        pass
    return con


def email_to_username(email: str) -> str:
    return email.split("@")[0]


def upsert_authors(con: duckdb.DuckDBPyConnection, commits: list[dict], repo_id: str):
    author_map: dict[str, dict] = {}
    for c in commits:
        e = c["author_email"]
        if e not in author_map:
            author_map[e] = {"name": c["author_name"], "count": 0}
        author_map[e]["count"] += 1

    for email, info in author_map.items():
        username = email_to_username(email)
        existing = con.execute(
            "SELECT commit_count FROM authors WHERE email=? AND repo_id=?",
            [email, repo_id]
        ).fetchone()
        if existing:
            con.execute(
                "UPDATE authors SET commit_count=commit_count+?, name=? WHERE email=? AND repo_id=?",
                [info["count"], info["name"], email, repo_id]
            )
        else:
            con.execute(
                "INSERT INTO authors VALUES (?, ?, ?, ?, ?)",
                [email, repo_id, info["name"], username, info["count"]]
            )


def _bulk_load(
    con: duckdb.DuckDBPyConnection,
    table: str,
    columns: list[str],
    rows: list[tuple],
    ignore_conflicts: bool = False,
) -> None:
    """用 CSV + COPY 做批量写入。

    DuckDB 的 executemany() 对每一行都要走一次 Python→C++ 的值编组（反射每个值
    的类型），百万行级别会退化到几十万次/秒以下、实测约 700μs/行，索引 Linux 内核
    这类大仓库时会卡几十分钟。改成先落盘成 CSV 再用 COPY 做批量导入（DuckDB 内置
    的向量化 CSV reader），同样的数据量从「小时级」降到「秒级」，且不引入
    pandas/pyarrow 这类重依赖。
    """
    if not rows:
        return
    col_list = ", ".join(columns)
    # 显式指定 CSV 方言，不要让 DuckDB 自动嗅探：文件路径/commit message 里可能
    # 包含逗号、引号、换行，Python csv 模块默认用双引号包裹+转义（QUOTE_MINIMAL），
    # 但 DuckDB 的 sniffer 只采样文件开头一段，样本里偏巧没遇到足够的转义场景时
    # 可能会错误猜成 quote=''，导致后面内容被截断（表现为该列值被错误地拆成两条）。
    csv_opts = "FORMAT csv, HEADER false, QUOTE '\"', ESCAPE '\"', DELIM ','"
    fd, tmp_path = tempfile.mkstemp(suffix=".csv")
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows(rows)

        if ignore_conflicts:
            stage = f"_stage_{table}"
            con.execute(f"CREATE TEMP TABLE {stage} AS SELECT {col_list} FROM {table} WHERE FALSE")
            con.execute(f"COPY {stage} FROM '{tmp_path}' ({csv_opts})")
            con.execute(f"INSERT OR IGNORE INTO {table} SELECT {col_list} FROM {stage}")
            con.execute(f"DROP TABLE {stage}")
        else:
            con.execute(f"COPY {table} ({col_list}) FROM '{tmp_path}' ({csv_opts})")
    finally:
        os.unlink(tmp_path)


def ingest(repo_path: str, db_path: str, incremental: bool = False) -> str:
    """索引一个本地 git 仓库到 DuckDB。返回 repo_id。"""
    repo_path = os.path.abspath(repo_path)
    repo_id = get_repo_id(repo_path)
    repo_name = get_repo_name(repo_path)

    con = init_db(db_path)

    # 查询上次的 last_hash（增量更新用）
    last_hash = None
    if incremental:
        row = con.execute(
            "SELECT last_hash FROM repos WHERE repo_id=?", [repo_id]
        ).fetchone()
        if row:
            last_hash = row[0]

    commits = parse_git_log(repo_path, since_hash=last_hash)

    if not commits:
        con.close()
        return repo_id

    # 写入 commits 表
    commit_rows = [
        (c["hash"], repo_id, c["author_email"], c["author_name"], c["ts"], c["message"])
        for c in commits
    ]
    _bulk_load(
        con, "commits",
        ["hash", "repo_id", "author_email", "author_name", "ts", "message"],
        commit_rows, ignore_conflicts=True,
    )

    # 写入 commit_files 表
    file_rows = []
    for c in commits:
        for f in c["files"]:
            file_rows.append((c["hash"], repo_id, f["path"], f["add"], f["del"]))
    _bulk_load(
        con, "commit_files",
        ["hash", "repo_id", "file_path", "additions", "deletions"],
        file_rows,
    )

    # 更新 authors 表
    upsert_authors(con, commits, repo_id)

    # 记录最新 hash
    latest_hash = commits[0]["hash"]  # git log 倒序，第一个是最新
    now_ts = int(datetime.now().timestamp())

    existing_repo = con.execute(
        "SELECT repo_id FROM repos WHERE repo_id=?", [repo_id]
    ).fetchone()
    if existing_repo:
        con.execute(
            "UPDATE repos SET last_hash=?, indexed_at=? WHERE repo_id=?",
            [latest_hash, now_ts, repo_id]
        )
    else:
        con.execute(
            "INSERT INTO repos VALUES (?, ?, ?, ?, ?)",
            [repo_id, repo_name, repo_path, latest_hash, now_ts]
        )

    con.close()
    return repo_id


def repo_summary(db_path: str, repo_id: str) -> Optional[dict]:
    """供 CLI 索引完成后打印概览用"""
    con = duckdb.connect(db_path, read_only=True)
    row = con.execute(
        "SELECT name, path FROM repos WHERE repo_id=?", [repo_id]
    ).fetchone()
    if not row:
        con.close()
        return None
    name, path = row
    total_commits = con.execute(
        "SELECT COUNT(*) FROM commits WHERE repo_id=?", [repo_id]
    ).fetchone()[0]
    total_authors = con.execute(
        "SELECT COUNT(*) FROM authors WHERE repo_id=?", [repo_id]
    ).fetchone()[0]
    total_files = con.execute(
        "SELECT COUNT(DISTINCT file_path) FROM commit_files WHERE repo_id=?", [repo_id]
    ).fetchone()[0]
    con.close()
    return {
        "name": name, "path": path, "repo_id": repo_id,
        "commits": total_commits, "authors": total_authors, "files": total_files,
    }


def print_stats(db_path: str):
    con = duckdb.connect(db_path, read_only=True)
    repos = con.execute("SELECT repo_id, name, path FROM repos").fetchall()
    for repo_id, name, path in repos:
        print(f"\n=== {name} ({repo_id}) ===")
        total_commits = con.execute(
            "SELECT COUNT(*) FROM commits WHERE repo_id=?", [repo_id]
        ).fetchone()[0]
        total_authors = con.execute(
            "SELECT COUNT(*) FROM authors WHERE repo_id=?", [repo_id]
        ).fetchone()[0]
        total_files = con.execute(
            "SELECT COUNT(DISTINCT file_path) FROM commit_files WHERE repo_id=?", [repo_id]
        ).fetchone()[0]
        print(f"  commits: {total_commits}, authors: {total_authors}, files: {total_files}")

        print("  Top 10 contributors:")
        rows = con.execute("""
            SELECT a.name, a.email, a.commit_count
            FROM authors a
            WHERE a.repo_id=?
            ORDER BY a.commit_count DESC
            LIMIT 10
        """, [repo_id]).fetchall()
        for name_, email, cnt in rows:
            print(f"    {name_:<20} {email:<35} {cnt} commits")

        print("  Top 10 hottest files (by churn):")
        rows = con.execute("""
            SELECT cf.file_path, SUM(cf.additions + cf.deletions) as churn, COUNT(*) as touches
            FROM commit_files cf
            JOIN commits c ON cf.hash = c.hash AND cf.repo_id = c.repo_id
            WHERE cf.repo_id=?
            GROUP BY cf.file_path
            ORDER BY churn DESC
            LIMIT 10
        """, [repo_id]).fetchall()
        for fpath, churn, touches in rows:
            print(f"    {fpath[-60:]:<60} churn={churn}, touches={touches}")
    con.close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Ingest git repo into DuckDB")
    parser.add_argument("repo_path", help="Path to git repository")
    parser.add_argument("--db", default="data.duckdb", help="DuckDB file path")
    parser.add_argument("--incremental", action="store_true", help="Incremental update")
    parser.add_argument("--stats", action="store_true", help="Print stats after ingestion")
    args = parser.parse_args()

    ingest(args.repo_path, args.db, incremental=args.incremental)
    if args.stats:
        print_stats(args.db)
