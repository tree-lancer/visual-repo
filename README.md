# Visual Repo

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![PyPI](https://img.shields.io/badge/pypi-visualrepo-3775A9?logo=pypi&logoColor=white)
![python](https://img.shields.io/badge/python-%3E%3D3.9-3776AB?logo=python&logoColor=white)

[English](./README-en.md) | 中文

把 Git commit 历史可视化成交互式地图，展示代码领土、贡献者占比与时间线演变。


## 在线体验

https://tree-lancer.github.io/visual-repo/

> 使用 `visualrepo export` 生成。这条命令可以把索引结果导出成一组静态 JSON 快照，前端展示，不依赖任何后端 —— 可以直接丢到 GitHub Pages / Vercel 等纯静态托管。


## 安装

```bash
uv add visualrepo
# 或
pip install visualrepo
```

## 使用

```bash
# 索引一个仓库（git 地址或本地路径都行）并启动，自动打开浏览器
visualrepo https://github.com/<owner>/<repo>.git
visualrepo ~/code/some-local-repo

# 已经索引过的仓库，增量更新后直接启动
visualrepo serve
```

数据和克隆下来的仓库缓存都存在 `~/.visualrepo/`。

常用选项：

```bash
visualrepo <target> --port 8080 --no-browser
visualrepo serve --port 8080 --no-browser
```

## 本地开发

```bash
uv sync
bash scripts/build_frontend.sh   # 构建前端，产出 src/visualrepo/web
uv run visualrepo <target>
```

前端热更新开发：

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173，自动代理到 127.0.0.1:7842
```

## License

[MIT](./LICENSE)
