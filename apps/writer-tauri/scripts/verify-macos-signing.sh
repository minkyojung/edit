#!/usr/bin/env bash
# Post-build gate for the notarized macOS build. Signing bugs here fail ONLY in
# the signed/notarized app (works fine in dev), so we assert the invariants the
# audit flagged (T1/T2) directly on the built .app before shipping:
#
#   1. The .app is Developer ID signed with hardened runtime enabled.
#   2. `bun` (re-signed by Tauri with our identity) carries the JIT entitlements
#      from Entitlements.plist — without them JSC's JIT is denied and the
#      sidecars die.
#   3. The nested `claude` CLI still carries ANTHROPIC's signature (team
#      Q6L2SF6YDW) — i.e. Tauri did NOT --deep re-sign it with our identity,
#      which would strip its allow-jit and crash it when the SDK spawns it.
#
# Usage: verify-macos-signing.sh [path/to/Octave.app]
# Defaults to the standard release bundle path. Exits non-zero on any failure.

set -euo pipefail

OUR_TEAM="6DQK5MQC4H"        # Minkyo Jung — Developer ID we sign with
ANTHROPIC_TEAM="Q6L2SF6YDW"  # Anthropic PBC — must remain on the claude CLI

APP="${1:-src-tauri/target/release/bundle/macos/Octave.app}"

fail() { echo "  ✗ FAIL: $1"; FAILED=1; }
pass() { echo "  ✓ $1"; }
FAILED=0

if [[ ! -d "$APP" ]]; then
  echo "✗ .app not found: $APP" >&2
  echo "  build it first: pnpm tauri build" >&2
  exit 2
fi
echo "Verifying signing on: $APP"

# 1. App bundle: our Developer ID + hardened runtime ------------------------
echo "[1/4] app bundle signature"
APP_INFO="$(codesign -dvvv "$APP" 2>&1 || true)"
echo "$APP_INFO" | grep -q "TeamIdentifier=$OUR_TEAM" \
  && pass "signed by our team ($OUR_TEAM)" \
  || fail "app not signed by $OUR_TEAM"
echo "$APP_INFO" | grep -qi "Authority=Developer ID Application" \
  && pass "Developer ID Application authority" \
  || fail "not a Developer ID Application signature"
echo "$APP_INFO" | grep -q "flags=.*runtime" \
  && pass "hardened runtime enabled" \
  || fail "hardened runtime NOT enabled"

# 2. bun: JIT entitlements present (our entitlements applied on re-sign) -----
echo "[2/4] bun JIT entitlements"
BUN="$(find "$APP" -type f -name 'bun*' ! -name '*.version' -perm +111 2>/dev/null | head -1)"
if [[ -z "$BUN" ]]; then
  fail "bun binary not found inside the app"
else
  BUN_ENT="$(codesign -d --entitlements - --xml "$BUN" 2>/dev/null | plutil -p - 2>/dev/null || true)"
  for key in allow-jit allow-unsigned-executable-memory disable-executable-page-protection; do
    echo "$BUN_ENT" | grep -q "com.apple.security.cs.$key" \
      && pass "bun has $key" \
      || fail "bun MISSING $key (JIT will be denied)"
  done
  # Capture first, then grep — piping codesign straight into `grep -q` lets
  # grep close the pipe on match, SIGPIPE-killing codesign, which pipefail then
  # reports as failure (a false negative).
  BUN_SIG="$(codesign -dvvv "$BUN" 2>&1 || true)"
  echo "$BUN_SIG" | grep -q "flags=.*runtime" \
    && pass "bun hardened runtime" || fail "bun not hardened"
fi

# 3. claude CLI: Anthropic signature preserved (NOT re-signed by us) ---------
echo "[3/4] nested claude CLI signature (T2)"
CLI="$(find "$APP" -type f -name 'claude' -perm +111 2>/dev/null | head -1)"
if [[ -z "$CLI" ]]; then
  fail "claude CLI not found inside the app"
else
  CLI_INFO="$(codesign -dvvv "$CLI" 2>&1 || true)"
  echo "$CLI_INFO" | grep -q "TeamIdentifier=$ANTHROPIC_TEAM" \
    && pass "claude CLI still Anthropic-signed ($ANTHROPIC_TEAM)" \
    || fail "claude CLI lost Anthropic signature — was it --deep re-signed?"
  if echo "$CLI_INFO" | grep -q "TeamIdentifier=$OUR_TEAM"; then
    fail "claude CLI was re-signed with OUR identity ($OUR_TEAM) — breaks its allow-jit"
  fi
fi

# 4. Gatekeeper acceptance (only passes AFTER notarize + staple) ------------
echo "[4/4] Gatekeeper assessment (needs notarize + staple)"
SPCTL_OUT="$(spctl -a -vvv --type execute "$APP" 2>&1 || true)"
if echo "$SPCTL_OUT" | grep -qi "accepted"; then
  pass "Gatekeeper accepts the app (notarized + stapled)"
else
  echo "  ⚠ not yet accepted — expected until the app is notarized and stapled"
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "✓ signing invariants hold"
else
  echo "✗ signing verification FAILED — do not ship this build"
  exit 1
fi
