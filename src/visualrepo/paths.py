"""paths.py — visualrepo 的本地数据目录管理

默认数据目录：~/.visualrepo
  ~/.visualrepo/data.duckdb   — 索引数据库
  ~/.visualrepo/repos/<id>    — git clone 下来的仓库缓存

可用环境变量覆盖：
  VISUALREPO_HOME  覆盖数据目录
  VISUALREPO_DB    覆盖数据库文件路径
"""

import os
from pathlib import Path


def data_dir() -> Path:
    d = Path(os.environ.get("VISUALREPO_HOME", str(Path.home() / ".visualrepo"))).expanduser()
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    override = os.environ.get("VISUALREPO_DB")
    if override:
        return Path(override).expanduser()
    return data_dir() / "data.duckdb"


def repos_dir() -> Path:
    d = data_dir() / "repos"
    d.mkdir(parents=True, exist_ok=True)
    return d
