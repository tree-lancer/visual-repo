"""cli.py — visualrepo 命令行入口

visualrepo <git地址或本地路径>   索引并启动服务（默认命令）
visualrepo serve                 对所有已索引仓库做一次增量更新后启动服务
"""

from __future__ import annotations

import threading
import webbrowser
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from visualrepo import git_ingest
from visualrepo.paths import db_path as _db_path

console = Console()


class DefaultGroup(typer.core.TyperGroup):
    """第一个 token 不是已知子命令时，回落到 `run` 默认命令。

    Click 的 group 会把首个位置参数当成子命令名，导致 `visualrepo <path>` 报
    "No such command"。这里在解析前把默认命令名插到最前面。
    """

    def parse_args(self, ctx, args):
        if args and args[0] not in self.commands and not args[0].startswith("-"):
            args = [DEFAULT_COMMAND, *args]
        return super().parse_args(ctx, args)


DEFAULT_COMMAND = "run"

app = typer.Typer(
    cls=DefaultGroup,
    add_completion=False,
    no_args_is_help=True,
    help="把 Git commit 历史可视化成交互式 Voronoi 地图",
)


def _print_summary(summary: dict) -> None:
    table = Table(title=f"📦 {summary['name']}", show_header=False, box=None, padding=(0, 2))
    table.add_row("Commits", f"[bold cyan]{summary['commits']}[/bold cyan]")
    table.add_row("Authors", f"[bold cyan]{summary['authors']}[/bold cyan]")
    table.add_row("Files", f"[bold cyan]{summary['files']}[/bold cyan]")
    console.print(table)


def _index_one(target: str) -> None:
    db = str(_db_path())
    with console.status("[bold cyan]定位/克隆仓库…[/bold cyan]", spinner="dots"):
        local_path = git_ingest.resolve_target(target)
    with console.status("[bold cyan]索引 commit 历史…[/bold cyan]", spinner="dots"):
        repo_id = git_ingest.ingest(str(local_path), db, incremental=True)
    summary = git_ingest.repo_summary(db, repo_id)
    console.print()
    if summary:
        _print_summary(summary)
    console.print()


def _refresh_all_indexed() -> None:
    db = str(_db_path())
    con = git_ingest.init_db(db)
    repos = con.execute("SELECT repo_id, name, path FROM repos").fetchall()
    con.close()

    if not repos:
        console.print("[yellow]还没有索引过任何仓库，直接启动空服务。[/yellow]")
        return

    refreshed = 0
    for _repo_id, name, path in repos:
        if not Path(path).exists():
            console.print(f"[yellow]⚠ 跳过 {name}：路径不存在 {path}[/yellow]")
            continue
        with console.status(f"[bold cyan]更新 {name}…[/bold cyan]", spinner="dots"):
            try:
                git_ingest.run_git(["pull", "--ff-only"], path)
            except Exception:
                pass
            git_ingest.ingest(path, db, incremental=True)
        refreshed += 1
    console.print(f"[green]✓ 已刷新 {refreshed} 个仓库[/green]")
    console.print()


def _serve(port: int, open_browser: bool) -> None:
    import uvicorn

    url = f"http://localhost:{port}"
    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    console.print(
        f"🚀 [bold green]Visual Repo[/bold green] 已启动：[bold underline]{url}[/bold underline]\n"
    )
    uvicorn.run("visualrepo.app:app", host="0.0.0.0", port=port, log_level="warning")


@app.command(DEFAULT_COMMAND, hidden=True)
def run(
    target: str = typer.Argument(
        ..., help="Git 仓库地址（https://... / git@...）或本地仓库路径"
    ),
    port: int = typer.Option(7842, "--port", "-p", help="服务端口"),
    no_browser: bool = typer.Option(False, "--no-browser", help="不自动打开浏览器"),
):
    """索引一个仓库并启动可视化服务"""
    _index_one(target)
    _serve(port, not no_browser)


@app.command()
def export(
    target: str = typer.Argument(
        ..., help="Git 仓库地址（https://... / git@...）或本地仓库路径"
    ),
    out: str = typer.Option(..., "--out", "-o", help="输出目录（静态 JSON 快照）"),
    top_files: int = typer.Option(1500, help="按全历史 churn 保留的最多文件数"),
    top_authors: int = typer.Option(60, help="按 commit 数保留的最多作者数"),
    top_profiles: int = typer.Option(30, help="预渲染完整画像的作者数（取 top_authors 的前 N 位）"),
):
    """索引一个仓库，并导出一份无需后端即可访问的静态 JSON 快照（用于 GitHub Pages / Vercel 等静态托管演示）"""
    from visualrepo.export_snapshot import export_snapshot

    _index_one(target)
    db = str(_db_path())
    local_path = git_ingest.resolve_target(target)
    repo_id = git_ingest.get_repo_id(str(local_path))
    with console.status(f"[bold cyan]导出静态快照到 {out}…[/bold cyan]", spinner="dots"):
        meta = export_snapshot(db, repo_id, out, top_files, top_authors, top_profiles)
    console.print(f"[green]✓ 已导出[/green]：{out}")
    console.print(
        f"  采样 {meta['sample_sizes']['files']} / {meta['real_totals']['files']} 个文件，"
        f"{meta['sample_sizes']['authors']} / {meta['real_totals']['authors']} 位作者"
    )


@app.command()
def serve(
    port: int = typer.Option(7842, "--port", "-p", help="服务端口"),
    no_browser: bool = typer.Option(False, "--no-browser", help="不自动打开浏览器"),
):
    """对所有已索引仓库做一次增量更新，再启动服务"""
    _refresh_all_indexed()
    _serve(port, not no_browser)


if __name__ == "__main__":
    app()
