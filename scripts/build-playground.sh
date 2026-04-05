#!/usr/bin/env bash
# Local development build for the TalaDB Playground.
# Uses published npm packages — no Rust or wasm-pack required.
set -euo pipefail

echo "▶ Installing dependencies…"
cd examples/web-vite
npm install

echo "▶ Building playground…"
npm run build

echo "✓ Build complete → examples/web-vite/dist"
