#!/usr/bin/env bash
# Build a self-contained sidecar package directory that the Tauri bundler
# can ship as a Resource. The runtime sidecar is `bun + this directory`,
# so it needs to include both source files and a real (non-symlinked)
# node_modules tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../sidecar"
OUT_DIR="$SCRIPT_DIR/../sidecar-pkg"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Source files only — no dev artifacts.
cp -R "$SIDECAR_DIR/src" "$OUT_DIR/"
cp "$SIDECAR_DIR/package.json" "$OUT_DIR/"

# Install production deps with hoisted layout so node_modules/ contains
# real files (not pnpm symlinks). --ignore-workspace keeps pnpm from
# treating sidecar-pkg as part of the dublin-v1 workspace.
pushd "$OUT_DIR" >/dev/null
CI=true pnpm install --prod --ignore-workspace --node-linker=hoisted >/dev/null
popd >/dev/null

echo "✓ packed: $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
