# Upgrading the pinned Claude Agent SDK version

`@anthropic-ai/claude-agent-sdk` is pinned EXACT (no `^`/`~`) in `package.json`.
It is never auto-bumped by `pnpm install`/`pnpm update`. Follow this checklist
any time you deliberately bump it.

1. Edit the exact version string in `apps/writer-tauri/sidecar/package.json`
   (`dependencies["@anthropic-ai/claude-agent-sdk"]`).
2. From `apps/writer-tauri/sidecar/`, run `pnpm install` to resolve the new
   version and update the lockfile. Commit the lockfile change alongside the
   version bump.
3. Export a real OAuth token and run the smoke test:
   ```
   export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
   pnpm run smoke
   ```
   This hits the real Anthropic API and incurs real API usage/cost. Every
   line must print `✓`. A `✗` means the SDK changed behavior this script
   depends on — do NOT proceed to step 4 until you've root-caused it and
   either fixed `server.mjs` or (if the script's own assumption was wrong)
   the script's assertions.
   - Pay particular attention to the `propose_edit + PostToolUse hook` line —
     this is the part of the codebase most likely to silently break on an
     SDK update, since the hook's exact contract (`matcher` string format,
     `updatedToolOutput`'s expected shape) isn't strictly documented by the
     SDK's own types, only inferred by convention.
4. Only after `pnpm run smoke` passes clean, run
   `apps/writer-tauri/scripts/pack-sidecar.sh` to regenerate the production
   `sidecar-pkg/` bundle.
5. Do one manual pass in the live app (launch it, send a chat message,
   trigger a `propose_edit` / Keep-Reject card) — the smoke test covers the
   wire protocol mechanically but not visual/UX regressions.
6. If this SDK version's behavior changes require updating `PROTOCOL.md`
   (new/changed methods, notifications, or error codes), do that in the
   same commit as the version bump.
7. Commit with a message describing what was verified — see
   `git log --grep="upgrade Claude Agent SDK"` for the style used by past
   bumps (e.g. the 0.2.121 → 0.3.187 upgrade).
