# Claude Code SDK integration — production-readiness audit

_Date: 2026-07-10. Method: 5 parallel adversarial sub-agent audits (Anthropic-engineer lens), read-only, evidence cited as `file:line`. Branch: `minkyojung/onboarding-sdk-deploy-prep`._

**Verdict: not shippable yet.** 4 hard deploy blockers + 2 signing traps + 3 prompt-injection security HIGHs + 2 reliability HIGHs. The error/rate-limit/cancellation layer the team called "canonical" is **verified genuinely solid** — see §6.

Integration surface: host (Rust) ↔ JSON-RPC (`framing.rs`/`jsonrpc.mjs`) ↔ Node sidecar (`server.mjs`) → `@anthropic-ai/claude-agent-sdk` (~0.3.187, pre-1.0) → `claude` CLI (per-platform binary). Two sidecars (chat + title), per-sidecar OAuth-token injection.

---

## 1. Deploy blockers (must fix before any release)

**B1 — No code-signing / notarization / entitlements configured at all.**
`src-tauri/tauri.conf.json:43-52` has `bundle` but no `macOS` section (no `signingIdentity`, `entitlements`, `hardenedRuntime`); no `.entitlements`/`.plist` in the repo; `.github/workflows/ci.yml` has no `tauri build`/notarization job; `docs/auto-update-plan.md` lists codesign+notarize as unchecked TODOs.
→ Any release `.app` is unsigned; Gatekeeper blocks it on a clean machine — the app never opens. Add `bundle.macOS` + entitlements + Developer ID + `APPLE_*` secrets + a macOS release job with notarization.

**B2 — Only the darwin-arm64 `claude` CLI is bundled → AI dead on Intel Macs.**
`sidecar-pkg/node_modules/@anthropic-ai/` contains only `claude-agent-sdk-darwin-arm64`. Root cause: `scripts/pack-sidecar.sh:45-47` runs `pnpm install --prod` on the host, installing only the host-arch optional dep. Prod launcher sets empty env (`claude_sidecar/manager.rs:585`) and relies on the SDK's default `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>')`, which throws when the package is absent → sidecar crash-loops → `sidecar:died {fatal:true}`.
→ Force-install both `-darwin-arm64` and `-darwin-x64` in `pack-sidecar.sh`, or drop Intel support explicitly. (arm64 resolution from `Resources/.../sidecar-pkg/node_modules` works — hoisted, real files.)

**B3 — App quit never terminates the sidecars (root cause of the observed orphans).**
The quit flow is `⌘Q/red-X → prevent_exit → app:close-requested → frontend confirm → app_quit → app.exit(0)` (`lib.rs:22-25, 308-317, 586-593`). Tauri/tao exits via `std::process::exit`, which **does not run Rust destructors**, so `SidecarManager`/`SidecarClient` are never dropped and `client.rs:116 kill_on_drop` never fires. Both node sidecars survive (reparented to launchd). Matches the orphaned `writer-tauri` + node processes observed live. The string `shutdown` never appears in the Rust sidecar code — teardown is never requested.
→ Add explicit teardown on `RunEvent::ExitRequested`/`Exit`: fetch the managed `SidecarManager`, send `shutdown` RPC with a short deadline, then hard-kill. Must be explicit (Drop won't run).

**B4 — The `claude` CLI grandchild is orphaned even when the node sidecar IS killed.**
`client.rs:113-116` kills node with SIGKILL (uncatchable → no cleanup, can't forward to the CLI child). `index.mjs:48-54` handles SIGTERM/SIGINT/stdin-end with bare `process.exit(0)` — no `child.kill()`/`AbortController.abort()`. Node doesn't kill children on exit by default.
→ In `index.mjs`, on signals/stdin-EOF, abort active chats via the existing `Server#handleShutdown` (`server.mjs:1641-1647`) before exit; from Rust prefer graceful `shutdown`/SIGTERM over SIGKILL; belt-and-suspenders: spawn each sidecar in its own process group and kill the group.

---

## 2. Signing traps (fail only in the signed/notarized build — "works in dev, dies shipped")

**T1 — Re-signing `bun` under hardened runtime strips its JIT entitlements.**
`binaries/bun-*` ships pre-signed with `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`. Tauri re-signs externalBin with the app identity; with no `bundle.macOS.entitlements` (B1) it signs with `--options runtime` + empty entitlements → JSC JIT denied by the kernel → bun crashes on startup → both sidecars die **only in the notarized build**.
→ Ship a custom entitlements plist carrying those keys; reference from `bundle.macOS.entitlements`; verify on a real notarized build.

**T2 — Nested `claude` CLI (215 MB Resource) must keep Anthropic's signature.**
Shipped via `resources: ["../sidecar-pkg/**/*"]` (`tauri.conf.json:51`), pre-signed by Anthropic PBC with allow-jit. If Tauri/manual `codesign --deep --force` re-signs it with the app identity + default entitlements, it loses allow-jit → CLI crashes when the SDK spawns it. **Do not use `--deep` signing**; confirm notarization accepts the nested Anthropic-signed binary.

---

## 3. Security — prompt injection (critical: the agent reads untrusted content and edits files)

**S1 — Plan-mode `Write` confinement is traversal-vulnerable (unnormalized `startsWith`).**
`server.mjs:1016-1019` allows the built-in `Write` tool when `file_path.startsWith(PLAN_MODE_PLANS_DIR)` with no `resolve()`/`normalize()`. `<plansdir>/../../../../Users/…/.zshrc` passes the prefix check. Plan mode exposes `Write` in `builtinTools` (`useChatRunner.ts:375`), documented as read-only "enforced by the gate". A note read while planning can inject a write to `~/.zshrc` (not in `SECRET_HOME_RELATIVE`) → arbitrary file write / shell-startup persistence, defeating both the read-only and whole-machine boundaries.
→ Resolve then boundary-check: `abs === dir || abs.startsWith(dir + sep)`. Never prefix-match unnormalized paths.

**S2 — OAuth token lives in the tool-subprocess env; Bash can read it.**
`server.mjs:1254-1258` injects `CLAUDE_CODE_OAUTH_TOKEN: this.token` into the query env, which the CLI passes to Bash subprocesses. The lockdown's secret protection covers files (`~/.ssh`, the token *store*) but not env vars. Injected "run `printenv CLAUDE_CODE_OAUTH_TOKEN`" surfaces the live `sk-ant-oat…` token into model context → writable into a note / exfiltrable. Default chat exposes `Bash` (`useChatRunner.ts:726-738`).
→ Strip auth env from the Bash/tool subprocess environment, and/or deny `Bash(printenv:*|env:*)`. _Needs runtime repro of env inheritance into the sandboxed Bash child; injection shape otherwise fully wired._

**S3 — `failIfUnavailable: false` silently downgrades to deny-rules-only.**
`server.mjs:121`. When Seatbelt can't initialize, the only remaining layer is the deny list, which blocks `curl/wget/nc/scp/sftp/telnet` (`server.mjs:97-105`) but NOT `python -c`/`node -e` egress or arbitrary file writes. The lockdown comment assumes chat is "trusted, user-driven" — wrong for the injection model: default chat ingests attacker-controlled note bodies AND exposes Bash.
→ For the chat surface, `failIfUnavailable: true` (fail-closed), or drop Bash from default chat, or refuse Bash when the sandbox didn't initialize.

---

## 4. Reliability HIGH

**R1 — Token refresh HTTP has no timeout and runs under `REFRESH_LOCK` → global hang.**
`oauth.rs:192-197, 223-232` use `reqwest::Client::new()` (reqwest default = no timeout); `do_refresh` runs while holding `REFRESH_LOCK` (`oauth.rs:259→283`). On a flaky network where the refresh POST connects but never responds, every `get_claude_token` caller blocks → **every chat/title/models start hangs indefinitely** (frozen spinner, no error path). One-line fix: a shared `reqwest::Client` with `.timeout(~15s)` + `connect_timeout`; a refresh failure then falls into the existing clear-and-return-None path.

**R2 — AUTH retry replays the entire turn (not idempotent).**
`server.mjs:1250, 1335` restart `query({ prompt: makeInput() })` on attempt 2 with the original prompt; attempt-1's streamed deltas/tool calls aren't rolled back. A long multi-turn run whose token expires mid-stream re-streams text and re-executes tools the user already saw/ran. (SDK/CLI can't self-refresh an env-injected OAuth token.) User-visible duplication depends on frontend `runId` reconciliation — _needs runtime confirmation_.
→ On AUTH retry prefer resume over recreate; at minimum discard attempt-1 partial output for that `runId` before replay.

**R3 — AUTH retry reuses `sessionId` create-semantics.**
`server.mjs:905` sets `options.sessionId` (create) once; attempt 2 reuses it. If attempt 1 persisted the session under `~/.claude/projects/` before 401'ing, re-creating the same id may collide → recoverable AUTH blip becomes a hard failure. _Needs runtime._ Fix: switch to `options.resume` on retry.

**P-HIGH — Graceful `shutdown` RPC is dead code from the host side.**
`server.mjs:612-613,1641-1647` implements the correct graceful teardown (abort chats, 250ms flush, exit), but no Rust code ever sends `shutdown` (0 hits). Wiring it (see B3) is the clean fix.

---

## 5. MED / LOW

- **MED (errors)** — `humanizeError` (`errorMessage.ts:18-49`) has no `INTERNAL` case; `INTERNAL:` / `rpc error: <code>` (`server.mjs:786`, `client.rs:24`) reach users verbatim. Add mappings + strip prefixes.
- **MED (errors)** — overage rate-limit sub-shape mishandled: `rateLimitPayload` reads only `info.resetsAt` (`server.mjs:1663-1670`), but overage carries `overageResetsAt`/`overageStatus` (`sdk.d.ts:3882-3898`); fail-fast only checks `status==='rejected'` (`server.mjs:1363`) → overage-only rejection skips fail-fast and shows a wrong/absent countdown.
- **MED (errors)** — `resetsAt` seconds→ms assumption (`index.ts:657-659`) unverified; **no tests** on `classifyError`/`humanizeError`/rate-limit/`CANCELLED`.
- **MED (auth)** — revoked-but-not-expired token → `#handleSetToken` waiter never fires (same token) → guaranteed 5s stall before the AUTH error (`server.mjs:654-658, 1462-1466`).
- **MED (auth)** — forced-logout (refresh failed / no refresh_token) clears the store (`oauth.rs:277-289`) with no explicit UI signal; `try_inject_token`'s `Ok(false)` is swallowed (`commands.rs:158-161`). Emit `auth:loggedOut`.
- **MED (security)** — Read/Glob/Grep/Bash accept absolute paths; only `SECRET_HOME_RELATIVE` denied → agent can read any non-secret file into context (`index.ts:726-738`). Benign until combined with S2/S3.
- **MED (security)** — plan mode re-adds `Task`/`Skill` (`server.mjs:1102-1106`, `allowDelegation` default true); a subagent's tool calls may not pass the parent plan-mode `canUseTool` gate → read-only bypass via delegation. _Needs repro._
- **MED (security)** — `move_note` / `edit_visualization` auto-apply with no Keep/Reject (`server.mjs:408-497`, `index.ts:602-629`); injected inbox content could move notes / rewrite viz specs. Vault-confined + reversible → low blast radius. Also `autoAcceptEdits` (acceptEdits mode) auto-applies `propose_*`.
- **MED (process)** — `restart` has no per-mode concurrency guard (`manager.rs:320-350`); exit-handler + dev-watcher can double-spawn → transient extra node + leaked `claude`. Dev hot-restart accumulates orphaned `claude` grandchildren over a session.
- **LOW** — sidecar `resolveVaultFile`/`checkOldString` fail open (`server.mjs:145,160`) — fine today (host `assertSafeRelPath` is the real gate) but fragile; `createGenericNote`/`move_note` strip only slashes not `..` (`wikiService.ts:270`, `index.ts:625`) → phantom catalog entry on flush error; cancellation grace ≤1.5s extra tokens (`server.mjs:1626-1635`); idle watchdog 180s (`server.mjs:1295`); token in CLI subprocess env is the SDK's required mechanism (readable via `ps eww` by a same-user process).

---

## 6. Verified solid (credit — no action needed)

- **Error/rate-limit/cancellation ("canonical") — all three headline claims are true.** No retry storms: sidecar attempt loop hard-capped at 2, only retries on AUTH (`server.mjs:1250,1458-1467`); hard rate-limit `status==='rejected'` fails fast, aborting the controller instead of grinding the SDK's ~10 internal retries (`server.mjs:1361-1409`). rate_limit single-source: `resetsAt`/`rateLimitType` derive from the SDK `rate_limit_event`, normalized once at the boundary (`index.ts:652-663`). Real cancellation: `claude_chat_cancel` aborts the same `AbortController` passed to `query()`, tearing down the CLI subprocess → token spend stops (`server.mjs:769,1335,1604-1639`). Teardown/idle: `releaseInput()` always in `finally`, 180s idle → `IDLE_TIMEOUT`, sidecar death settles every in-flight run — a stalled turn errors, never hangs forever.
- **Crash-loop supervision sound**: exponential backoff 500ms→30s cap, `MAX_CONSECUTIVE_RESTARTS=5`, streak reset after 60s healthy uptime, terminal `sidecar:died {fatal:true}` (`manager.rs:67-83,285-317`).
- **Runtime is bundled `bun`**, not system node (`manager.rs:546-586`, `externalBin: ["binaries/bun"]`).
- **NO_TOKEN / NOT_INITIALIZED** races well-guarded (initialize precedes setToken; per-request re-inject closes the first-chat window).
- **Token transport** over stdin JSON-RPC, never argv/spawn-env; startup logs print env keys only; `setToken` errors never echo the token; `sk-ant-oat` prefix validated.
- **Vault WRITE confinement** is 100% host-side and sound: `propose_*` are relays → reviewable `PendingChange` → disk write only on Keep via `writeVaultFile`→`resolveVaultPath`→`assertSafeRelPath` (rejects absolute + segment-level `..`).

---

## 7. Recommended fix order

**1st — release gating (can't ship without):**
1. Signing + notarization pipeline (B1) + custom entitlements plist (T1) + no `--deep` (T2) → **verify on a signed build on a clean machine**.
2. Bundle the Intel CLI (B2), or drop Intel explicitly.
3. Sidecar teardown on exit (B3 + B4 + P-HIGH): `shutdown` RPC → hard-kill, process-group kill.

**2nd — security (strongly advised before release; injection threat is real):**
4. S1 (normalize the plans-dir check), S2 (scrub OAuth token from tool-subprocess env), S3 (fail-closed sandbox for the Bash-bearing chat).

**3rd — reliability:**
5. R1 (refresh timeout — one line), R2/R3 (idempotent AUTH retry).

**4th — polish:**
6. `INTERNAL`/`rpc error:` copy, overage rate-limit shape, and add tests over the error/rate-limit surface.

---

_All findings are `file:line`-cited and directly actionable. Items marked "needs runtime repro" require exercising the live app (expired/revoked token, notarized build on a clean machine, sandbox-down, delegation under plan mode)._
