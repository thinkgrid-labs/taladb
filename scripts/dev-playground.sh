#!/usr/bin/env bash
# dev-playground.sh
#
# Builds taladb packages locally and patches the taladb-playground's
# node_modules in-place so you can test without publishing to npm.
#
# Usage:
#   bash scripts/dev-playground.sh
#
# Requirements: wasm-pack, cargo, pnpm, node

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLAYGROUND="$REPO/../taladb-playground"

if [ ! -d "$PLAYGROUND" ]; then
  echo "ERROR: taladb-playground not found at $PLAYGROUND"
  exit 1
fi

echo "==> Building WASM (@taladb/web)..."
wasm-pack build "$REPO/packages/taladb-web" --target web --out-dir pkg --release
# wasm-pack generates pkg/.gitignore with *.wasm — remove it so files aren't
# accidentally excluded when we copy them.
rm -f "$REPO/packages/taladb-web/pkg/.gitignore"

echo "==> Building TypeScript (taladb)..."
(cd "$REPO/packages/taladb" && pnpm exec tsup)

echo "==> Building React hooks (@taladb/react)..."
(cd "$REPO/packages/taladb-react" && pnpm exec tsup)

echo "==> Patching playground node_modules..."

# @taladb/web — copy pkg/ and worker/
WEB_NM="$PLAYGROUND/node_modules/@taladb/web"
rm -rf "$WEB_NM/pkg"
cp -r "$REPO/packages/taladb-web/pkg"    "$WEB_NM/pkg"
rm -rf "$WEB_NM/worker"
cp -r "$REPO/packages/taladb-web/worker" "$WEB_NM/worker"

# taladb — copy src/, dist/, and package.json (package.json carries the
# `exports` field with the `browser` condition for index.browser.mjs)
TALADB_NM="$PLAYGROUND/node_modules/taladb"
rm -rf "$TALADB_NM/dist" "$TALADB_NM/src"
cp -r "$REPO/packages/taladb/dist"        "$TALADB_NM/dist"
cp -r "$REPO/packages/taladb/src"         "$TALADB_NM/src"
cp    "$REPO/packages/taladb/package.json" "$TALADB_NM/package.json"

# @taladb/react — copy dist/ and package.json
REACT_NM="$PLAYGROUND/node_modules/@taladb/react"
mkdir -p "$REACT_NM"
rm -rf "$REACT_NM/dist"
cp -r "$REPO/packages/taladb-react/dist"        "$REACT_NM/dist"
cp    "$REPO/packages/taladb-react/package.json" "$REACT_NM/package.json"

echo ""
echo "Done. Run the playground:"
echo "  cd $PLAYGROUND && pnpm dev"
