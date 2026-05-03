#!/usr/bin/env bash
# Build the sidecar as a self-contained executable for every target Tauri
# might bundle. We compile all four on whichever host runs this — bun
# cross-compiles cleanly. Verifying the non-host binaries actually run is a
# separate (per-platform) step, deferred until we ship to those platforms.
#
# Tauri's externalBin convention: the file name must end with the Rust target
# triple of the *bundle* target. The Tauri bundler picks the right one when
# you `tauri build`.

set -euo pipefail

cd "$(dirname "$0")"

OUT_DIR="../src-tauri/binaries"
mkdir -p "$OUT_DIR"

ENTRY="src/index.mjs"

build_one() {
  local bun_target="$1"
  local rust_triple="$2"
  local suffix="$3"
  local out="$OUT_DIR/claude-sidecar-${rust_triple}${suffix}"

  echo "→ ${bun_target}  →  $(basename "$out")"
  bun build "$ENTRY" --compile --target="$bun_target" --outfile "$out" >/dev/null
  chmod +x "$out"
}

build_one bun-darwin-arm64  aarch64-apple-darwin           ""
build_one bun-darwin-x64    x86_64-apple-darwin            ""
build_one bun-linux-x64     x86_64-unknown-linux-gnu       ""
build_one bun-windows-x64   x86_64-pc-windows-msvc         ".exe"

echo
echo "✓ built sidecars:"
ls -lh "$OUT_DIR"/claude-sidecar-*
