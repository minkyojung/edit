#!/usr/bin/env bash
# Ensure src-tauri/binaries/ contains a pinned bun for the host platform
# (or for the full matrix when called with --all-targets). Bun is the
# runtime for the Claude sidecar (sidecar/src/index.mjs); we pin a version
# instead of relying on system install so every developer / CI run uses
# the same binary.
#
# proof-server was previously built here too; it is gone (Phase 3.D —
# every doc operation now runs against the local Y.Doc + IDB).
#
# Idempotent: re-running is a no-op once binaries match the pinned
# version. Safe to call from postinstall and beforeDevCommand.

set -euo pipefail

BUN_VERSION="1.3.13"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WT_ROOT="$SCRIPT_DIR/.."
OUT_DIR="$WT_ROOT/src-tauri/binaries"
mkdir -p "$OUT_DIR"

ALL_TARGETS=false
if [[ "${1:-}" == "--all-targets" ]]; then
  ALL_TARGETS=true
fi

# Returns: "<bun_release_platform>|<rust_triple>|<suffix>"
target_row() {
  case "$1" in
    aarch64-apple-darwin)      echo "darwin-aarch64|aarch64-apple-darwin|" ;;
    x86_64-apple-darwin)       echo "darwin-x64|x86_64-apple-darwin|" ;;
    x86_64-unknown-linux-gnu)  echo "linux-x64|x86_64-unknown-linux-gnu|" ;;
    aarch64-unknown-linux-gnu) echo "linux-aarch64|aarch64-unknown-linux-gnu|" ;;
    x86_64-pc-windows-msvc)    echo "windows-x64|x86_64-pc-windows-msvc|.exe" ;;
    *) echo "✗ unsupported target: $1" >&2; exit 1 ;;
  esac
}

ALL_TRIPLES=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-gnu
  x86_64-pc-windows-msvc
)

host_triple() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   echo "aarch64-apple-darwin" ;;
    Darwin-x86_64)  echo "x86_64-apple-darwin" ;;
    Linux-x86_64)   echo "x86_64-unknown-linux-gnu" ;;
    Linux-aarch64)  echo "aarch64-unknown-linux-gnu" ;;
    *) echo "✗ unsupported host: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
}

HOST_TRIPLE=$(host_triple)

ensure_bun() {
  local triple="$1"
  IFS='|' read -r bun_release_platform rust_triple suffix <<< "$(target_row "$triple")"
  local target="$OUT_DIR/bun-${rust_triple}${suffix}"
  local marker="${target}.version"

  if [[ -f "$target" && -f "$marker" && "$(cat "$marker")" == "$BUN_VERSION" ]]; then
    return 0
  fi

  echo "→ download bun ${BUN_VERSION} (${bun_release_platform})"
  local tmp
  tmp=$(mktemp -d)
  local url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${bun_release_platform}.zip"
  if ! curl -sSfL "$url" -o "$tmp/bun.zip"; then
    rm -rf "$tmp"
    echo "✗ failed to download $url" >&2
    exit 1
  fi
  unzip -q "$tmp/bun.zip" -d "$tmp"
  local extracted="$tmp/bun-${bun_release_platform}/bun${suffix}"
  if [[ ! -f "$extracted" ]]; then
    echo "✗ unexpected zip layout from $url" >&2
    ls -R "$tmp" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mv "$extracted" "$target"
  chmod +x "$target"
  echo "$BUN_VERSION" > "$marker"
  rm -rf "$tmp"
}

if $ALL_TARGETS; then
  for triple in "${ALL_TRIPLES[@]}"; do ensure_bun "$triple"; done
else
  ensure_bun "$HOST_TRIPLE"
fi

echo "✓ binaries ready in $OUT_DIR"
