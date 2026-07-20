#!/usr/bin/env bash
# One-command signed + notarized macOS release (Apple Silicon / arm64).
#
#   preflight → tauri build (sign + notarize) → verify:signing (T1/T2) → staple
#
# The only real secrets are APPLE_ID + APPLE_PASSWORD (app-specific password).
# This script reads them from the ENVIRONMENT, so supply them either way:
#
#   • 1Password (recommended — secrets never touch disk):
#       op run --env-file=.env.signing.op -- pnpm release
#
#   • plaintext .env.signing (simplest — gitignored):
#       cp .env.signing.example .env.signing   # then fill it in
#       pnpm release
#     (auto-sourced below ONLY if APPLE_PASSWORD isn't already in the env, so it
#      never clobbers values op run already injected)
#
# Non-secret config (signing identity, team id, updater key) is set here — none
# of it is sensitive (the cert name is visible via `security find-identity`).

set -euo pipefail
cd "$(dirname "$0")/.."   # apps/writer-tauri

# --- non-secret signing config -------------------------------------------------
export APPLE_SIGNING_IDENTITY="Developer ID Application: Minkyo Jung (6DQK5MQC4H)"
export APPLE_TEAM_ID="6DQK5MQC4H"

# --- updater signing key (passwordless; read from file at build time) ----------
UPDATER_KEY="${TAURI_SIGNING_KEY_FILE:-$HOME/.tauri/octave-updater.key}"
[[ -f "$UPDATER_KEY" ]] || { echo "✗ updater key not found: $UPDATER_KEY" >&2; exit 2; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --- secrets: source plaintext .env.signing ONLY if not already in the env -----
if [[ -z "${APPLE_PASSWORD:-}" && -f .env.signing ]]; then
  set -a; source .env.signing; set +a
fi

# --- preflight -----------------------------------------------------------------
: "${APPLE_ID:?set APPLE_ID — see .env.signing.example}"
: "${APPLE_PASSWORD:?set APPLE_PASSWORD (app-specific password) — see .env.signing.example}"
security find-identity -v -p codesigning | grep -q "$APPLE_TEAM_ID" \
  || { echo "✗ signing cert for team $APPLE_TEAM_ID not in keychain" >&2; exit 1; }
echo "✓ preflight ok — signing as $APPLE_SIGNING_IDENTITY"

# --- release notes must exist for this version (else the "What's new" card
#     silently no-shows after the update — see check-changelog.mjs) --------------
node scripts/check-changelog.mjs

# --- build (Tauri signs, then notarizes because the APPLE_* vars are set) -------
pnpm tauri build

# --- verify the signing invariants (T1/T2) on the built app --------------------
bash scripts/verify-macos-signing.sh

# --- staple the notarization ticket (Tauri staples the .app; the .dmg often
#     still needs it, so do both — idempotent) ------------------------------------
APP="src-tauri/target/release/bundle/macos/Octave.app"
xcrun stapler staple "$APP" 2>/dev/null || echo "  (app: already stapled / skipped)"
DMG="$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
if [[ -n "$DMG" ]]; then
  xcrun stapler staple "$DMG" 2>/dev/null || echo "  (dmg: already stapled / skipped)"
  xcrun stapler validate "$DMG" >/dev/null && echo "✓ dmg stapled: $DMG"
fi

echo "✓ release build complete — signed, notarized, stapled"
