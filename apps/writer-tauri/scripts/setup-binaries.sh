#!/usr/bin/env bash
# Ensure src-tauri/binaries/ contains everything Tauri's externalBin
# declares — pinned bun + compiled proof-server — for the host platform
# by default, or for the full matrix when called with --all-targets.
#
# Idempotent: re-running is a no-op once binaries match the pinned
# version. Safe to call from postinstall and beforeDevCommand.
#
# Bun is downloaded from the official releases instead of relying on
# a system install so every developer / CI run uses the same version.
# proof-server is built with that same pinned bun, not whatever the
# user happens to have on PATH.

set -euo pipefail

BUN_VERSION="1.3.13"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WT_ROOT="$SCRIPT_DIR/.."
OUT_DIR="$WT_ROOT/src-tauri/binaries"
PROOF_SDK_ROOT="$WT_ROOT/../../../proof-sdk"
mkdir -p "$OUT_DIR"

ALL_TARGETS=false
if [[ "${1:-}" == "--all-targets" ]]; then
  ALL_TARGETS=true
fi

# Returns: "<bun_release_platform>|<bun_compile_target>|<rust_triple>|<suffix>"
target_row() {
  case "$1" in
    aarch64-apple-darwin)      echo "darwin-aarch64|bun-darwin-arm64|aarch64-apple-darwin|" ;;
    x86_64-apple-darwin)       echo "darwin-x64|bun-darwin-x64|x86_64-apple-darwin|" ;;
    x86_64-unknown-linux-gnu)  echo "linux-x64|bun-linux-x64|x86_64-unknown-linux-gnu|" ;;
    aarch64-unknown-linux-gnu) echo "linux-aarch64|bun-linux-arm64|aarch64-unknown-linux-gnu|" ;;
    x86_64-pc-windows-msvc)    echo "windows-x64|bun-windows-x64|x86_64-pc-windows-msvc|.exe" ;;
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
  IFS='|' read -r bun_release_platform _ rust_triple suffix <<< "$(target_row "$triple")"
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

ensure_proof_server() {
  local triple="$1"
  IFS='|' read -r _ bun_compile_target rust_triple suffix <<< "$(target_row "$triple")"
  local target="$OUT_DIR/proof-server-${rust_triple}${suffix}"
  local marker="${target}.bun-version"

  if [[ -f "$target" && -f "$marker" && "$(cat "$marker")" == "$BUN_VERSION" ]]; then
    return 0
  fi

  if [[ ! -f "$PROOF_SDK_ROOT/server/index.ts" ]]; then
    echo "✗ proof-sdk entry not found at $PROOF_SDK_ROOT/server/index.ts" >&2
    exit 1
  fi

  local host_bun="$OUT_DIR/bun-${HOST_TRIPLE}"
  if [[ ! -x "$host_bun" ]]; then
    echo "✗ host bun missing at $host_bun (ensure_bun must run first)" >&2
    exit 1
  fi

  echo "→ build proof-server (${bun_compile_target})"
  (cd "$PROOF_SDK_ROOT" && "$host_bun" build server/index.ts \
    --compile --target="$bun_compile_target" --outfile "$target") >/dev/null
  chmod +x "$target"
  echo "$BUN_VERSION" > "$marker"
}

if $ALL_TARGETS; then
  for triple in "${ALL_TRIPLES[@]}"; do ensure_bun "$triple"; done
  for triple in "${ALL_TRIPLES[@]}"; do ensure_proof_server "$triple"; done
else
  ensure_bun "$HOST_TRIPLE"
  ensure_proof_server "$HOST_TRIPLE"
fi

echo "✓ binaries ready in $OUT_DIR"
