# Visual Repo

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![PyPI](https://img.shields.io/badge/pypi-visualrepo-3775A9?logo=pypi&logoColor=white)
![python](https://img.shields.io/badge/python-%3E%3D3.9-3776AB?logo=python&logoColor=white)

English | [中文](./README.md)

Visualize a Git repository's commit history as an interactive map — showing code ownership, contributor footprints, and how territories shift over time.


## Live demo

https://tree-lancer.github.io/visual-repo/

> Generated with `visualrepo export`. This command dumps the indexed data into a set of static JSON snapshots and renders them entirely in the frontend — no backend required, so it can be hosted directly on GitHub Pages / Vercel or any static host.


## Install

```bash
uv add visualrepo
# or
pip install visualrepo
```

## Usage

```bash
# Index a repo (URL or local path) and open the map in your browser
visualrepo https://github.com/<owner>/<repo>.git
visualrepo ~/code/some-local-repo

# Already indexed? Pull incremental updates and start the server
visualrepo serve
```

All data and cloned repos are stored under `~/.visualrepo/`.

Common options:

```bash
visualrepo <target> --port 8080 --no-browser
visualrepo serve    --port 8080 --no-browser
```

## Local development

```bash
uv sync
bash scripts/build_frontend.sh   # builds frontend → src/visualrepo/web
uv run visualrepo <target>
```

Frontend hot-reload:

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173, proxied to 127.0.0.1:7842
```

## License

[MIT](./LICENSE)
