#!/usr/bin/env bash
# build_frontend.sh — 构建前端静态资源并拷贝进 Python 包
# 发布 visualrepo 到 PyPI 前必须先执行一次，生成 src/visualrepo/web

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/frontend"
npm install
npm run build

rm -rf "$ROOT/src/visualrepo/web"
cp -r "$ROOT/frontend/dist" "$ROOT/src/visualrepo/web"

echo "✅ 前端已构建并拷贝到 src/visualrepo/web"
