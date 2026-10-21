#!/usr/bin/env bash
# build_demo.sh — 生成一份无需后端即可访问的静态 demo（GitHub Pages / Vercel 通用）
#
# 用法：
#   bash scripts/build_demo.sh <git地址或本地路径> <输出目录> [base-path]
#
# 示例：
#   # 部署到 Vercel（根路径）
#   bash scripts/build_demo.sh https://github.com/torvalds/linux.git demo
#
#   # 部署到 GitHub Pages（仓库名作为子路径，比如 /visual-repo/）
#   bash scripts/build_demo.sh https://github.com/torvalds/linux.git docs /visual-repo/

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?用法: build_demo.sh <target> <out_dir> [base-path]}"
OUT="${2:?用法: build_demo.sh <target> <out_dir> [base-path]}"
BASE_PATH="${3:-/}"
VISUALREPO_BIN="${VISUALREPO_BIN:-visualrepo}"
TOP_FILES="${TOP_FILES:-1500}"
TOP_AUTHORS="${TOP_AUTHORS:-60}"
TOP_PROFILES="${TOP_PROFILES:-30}"

OUT_ABS="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")" || OUT_ABS="$ROOT/$OUT"
rm -rf "$OUT_ABS"
mkdir -p "$OUT_ABS"

echo "== 1/3 导出静态数据快照 =="
"$VISUALREPO_BIN" export "$TARGET" \
  --out "$OUT_ABS/data" \
  --top-files "$TOP_FILES" \
  --top-authors "$TOP_AUTHORS" \
  --top-profiles "$TOP_PROFILES"

echo "== 2/3 构建静态前端（demo 模式）=="
cd "$ROOT/frontend"
npm install
VITE_STATIC_MODE=true npm run build -- --base="./"

echo "== 3/3 合并产物 =="
cp -r dist/* "$OUT_ABS/"

echo "✅ demo 已生成：$OUT_ABS（base path: $BASE_PATH）"
echo "   本地预览：npx serve $OUT_ABS"
