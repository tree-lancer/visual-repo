#!/usr/bin/env bash
# build_demo.sh — 生成/追加一份无需后端即可访问的静态 demo（GitHub Pages / Vercel 通用）
#
# 用法：
#   bash scripts/build_demo.sh <slug> <git地址或本地路径> <输出目录> [仓库展示名]
#
# 每次调用只处理一个仓库，写入 <输出目录>/data/<slug>/，并把它注册进
# <输出目录>/data/manifest.json（已存在的 slug 会被覆盖更新，不影响其他仓库）。
# 多个仓库可以反复调用这个脚本叠加到同一个输出目录，前端用已有的仓库下拉框
# 直接切换。
#
# 示例：
#   bash scripts/build_demo.sh linux https://github.com/torvalds/linux.git demo "linux (torvalds/linux)"
#   bash scripts/build_demo.sh spark https://github.com/apache/spark.git demo "spark (apache/spark)"
#
# 部署到 GitHub Pages 子路径时，构建前端那一步会用相对路径 "./"，Vercel/Pages 都适用。

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:?用法: build_demo.sh <slug> <target> <out_dir> [display-name]}"
TARGET="${2:?用法: build_demo.sh <slug> <target> <out_dir> [display-name]}"
OUT="${3:?用法: build_demo.sh <slug> <target> <out_dir> [display-name]}"
DISPLAY_NAME="${4:-$SLUG}"
VISUALREPO_BIN="${VISUALREPO_BIN:-visualrepo}"
TOP_FILES="${TOP_FILES:-1500}"
TOP_AUTHORS="${TOP_AUTHORS:-60}"
TOP_PROFILES="${TOP_PROFILES:-30}"

OUT_ABS="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")" || OUT_ABS="$ROOT/$OUT"
mkdir -p "$OUT_ABS/data/$SLUG"

echo "== 1/3 导出静态数据快照（$SLUG）=="
"$VISUALREPO_BIN" export "$TARGET" \
  --out "$OUT_ABS/data/$SLUG" \
  --top-files "$TOP_FILES" \
  --top-authors "$TOP_AUTHORS" \
  --top-profiles "$TOP_PROFILES"

echo "== 2/3 更新 manifest.json =="
python3 - "$OUT_ABS/data/manifest.json" "$SLUG" "$DISPLAY_NAME" << 'PYEOF'
import json, sys
path, slug, name = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        manifest = json.load(f)
except FileNotFoundError:
    manifest = []
manifest = [e for e in manifest if e.get("slug") != slug]
manifest.append({"slug": slug, "name": name})
with open(path, "w") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
PYEOF

echo "== 3/3 构建静态前端（demo 模式）=="
cd "$ROOT/frontend"
npm install
VITE_STATIC_MODE=true npm run build -- --base="./"
rm -rf "$OUT_ABS/assets"
cp -r dist/index.html dist/favicon.svg dist/assets "$OUT_ABS/"

echo "✅ demo 已更新：$OUT_ABS（新增/刷新仓库：$SLUG）"
echo "   本地预览：cd $OUT_ABS && python3 -m http.server 8080"
