#!/usr/bin/env bash
# Build a self-contained sidecar package directory that the Tauri bundler
# can ship as a Resource. The runtime sidecar is `bun + this directory`,
# so it needs to include both source files and a real (non-symlinked)
# node_modules tree.
#
# Idempotent: hashes the inputs (package.json + src/** + this script)
# into a marker. Re-runs are no-ops when nothing relevant changed —
# important so beforeDevCommand can call us cheaply on every dev start.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../sidecar"
OUT_DIR="$SCRIPT_DIR/../sidecar-pkg"
MARKER="$OUT_DIR/.input-hash"

# Hash everything that affects the output: deps, sources, and this
# script's own logic. Sorted listing keeps the hash stable across
# filesystems.
compute_input_hash() {
  {
    shasum -a 256 "$SIDECAR_DIR/package.json" "$0"
    find "$SIDECAR_DIR/src" -type f -print0 | sort -z | xargs -0 shasum -a 256
  } | shasum -a 256 | awk '{print $1}'
}

INPUT_HASH=$(compute_input_hash)

if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$INPUT_HASH" && -d "$OUT_DIR/node_modules" ]]; then
  echo "✓ sidecar-pkg up to date (hash $INPUT_HASH)"
  exit 0
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Source files only — no dev artifacts.
cp -R "$SIDECAR_DIR/src" "$OUT_DIR/"
cp "$SIDECAR_DIR/package.json" "$OUT_DIR/"

# Install production deps with hoisted layout so node_modules/ contains
# real files (not pnpm symlinks). --ignore-workspace keeps pnpm from
# treating sidecar-pkg as part of the workspace.
pushd "$OUT_DIR" >/dev/null
CI=true pnpm install --prod --ignore-workspace --node-linker=hoisted >/dev/null
popd >/dev/null

echo "$INPUT_HASH" > "$MARKER"
echo "✓ packed: $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1)) hash=$INPUT_HASH"
