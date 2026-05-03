#!/usr/bin/env bash
# Compile proof-server (sibling proof-sdk workspace) into a self-contained
# binary so the prod .app can run its own editor backend without depending
# on Node, tsx, or the dev workspace layout.
#
# Mirrors sidecar/build.sh — same Tauri externalBin convention.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROOF_SDK_ROOT="$SCRIPT_DIR/../../../../proof-sdk"
ENTRY="$PROOF_SDK_ROOT/server/index.ts"
OUT_DIR="$SCRIPT_DIR/../src-tauri/binaries"

if [[ ! -f "$ENTRY" ]]; then
  echo "✗ proof-sdk entry not found at $ENTRY" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

build_one() {
  local bun_target="$1"
  local rust_triple="$2"
  local suffix="$3"
  local out="$OUT_DIR/proof-server-${rust_triple}${suffix}"
  echo "→ ${bun_target}  →  $(basename "$out")"
  (cd "$PROOF_SDK_ROOT" && bun build "$ENTRY" --compile --target="$bun_target" --outfile "$out") >/dev/null
  chmod +x "$out"
}

build_one bun-darwin-arm64  aarch64-apple-darwin           ""
build_one bun-darwin-x64    x86_64-apple-darwin            ""
build_one bun-linux-x64     x86_64-unknown-linux-gnu       ""
build_one bun-windows-x64   x86_64-pc-windows-msvc         ".exe"

echo
echo "✓ built proof-servers:"
ls -lh "$OUT_DIR"/proof-server-*
