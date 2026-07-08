# Remaining work — onboarding redesign + launch readiness

_Last updated: 2026-07-08. Branch: `minkyojung/agent-memory-seam`._

Living checklist. `[x]` done this session, `[ ]` remaining, `[~]` partial/rough.

---

## 1. Onboarding redesign

### Design principle (from research)
Onboarding gates everything (launcher appears only after it ends). Defer login
to just-in-time; keep it skippable, not a wall. Fewest steps; the "aha"
(profile) is a non-blocking empty-state in the editor, not a panel. Trust-prime
the AI's file access (our sandbox is a selling point).

Flow: **P1 Welcome/trust → P2 Connect Claude (skippable) → P3 Folder (mandatory)
→ P4 Done → [project window opens] → editor (Welcome.md + empty-state suggestions)**.

### Done
- [x] Gate before the launcher: `BootGate` launcher branch shows onboarding on
  first run (bootstrapCompleted false), else `VaultLauncher`.
- [x] Panels split into pure presentation under `src/profile/ui/onboarding/`:
  `WelcomePanel`, `ConnectPanel`, `FolderPanel`, `DonePanel`.
- [x] `OnboardingLauncher` drives welcome → connect → folder → done; folder pick
  stores the choice, DonePanel's "Open Octave" opens the project window.
- [x] Folder step is mandatory (no skip); translation-project button removed
  (existing translation folders are still auto-detected on pick).
- [x] `/onboard` standalone design-preview page (no sidebar/editor) — flips all
  panels via Prev/Next; sidebar "Onboarding" entry. Iterate without restart.
- [x] Compact centred onboarding window (900×580), restored on leave.
- [x] `seedWelcomeNote`: seed `Welcome.md` into a brand-new vault (CLAUDE.md
  absent) so first run opens on content, not a blank editor. (CLAUDE.md itself
  was already seeded by `seedWikiDefaults`.)
- [x] **Handoff ordering (#7):** `openProject` now awaits `openProjectWindow`
  BEFORE recording the project / marking `bootstrapCompleted`. A spawn failure
  leaves onboarding intact (user retries) instead of stranding a first-run user
  on the empty picker; and because the launcher is hidden before the flag flips,
  the VaultLauncher no longer flashes. Added a `busy` guard (no double-open) +
  retry-able error line on `DonePanel`. (commit `8e98a612`)

### Remaining — polish
- [~] **P2 Connect: real OAuth wiring.** Buttons currently just advance. Wire
  `ConnectPanel.onConnect` to the real connect flow (`ConnectClaudeDialog` /
  `useClaudeAuth`); keep "I'll do this later" as advance.
- [ ] **Image assets.** Right column is a "Preview image" placeholder in all
  panels — swap for real illustrations/screenshots.
- [ ] **Copy / spacing / column ratio** pass on all 4 panels.
- [ ] **Transitions + progress indicator** (e.g. 1/4 dots, slide between steps).
- [ ] **Window chrome / traffic lights** during onboarding (deferred polish —
  don't fully remove; tidy title bar / positioning).
- [ ] Decide: keep the compact-window resize, or make the returning-user
  `VaultLauncher` compact too for consistency.

### Remaining — editor side (non-panel)
- [ ] **P3 landing empty-state**: in a fresh/empty editor, show first-action
  suggestion cards — the profile "aha" ("Let AI draft your profile from your
  writing") prominent, plus "summarize / organize". Non-blocking.
- [ ] **P4 Connect Claude JIT**: every AI entry point (chat, Analyze, capture
  organize) shows a proper "Connect Claude" CTA instead of the raw
  `no claude token` error when unauthenticated. (This is the original onboarding
  bug's canonical fix — currently the error still surfaces if the user skipped
  connect and hasn't connected.)

### Remaining — from the code review (not yet done)
- [ ] **Window height clamp (#10):** `ONBOARDING_H = 580`
  (`OnboardingLauncher.tsx`) is below the window `minHeight: 600`
  (`tauri.conf.json`), so `setSize` is clamped to 900×600 — the live launcher is
  20px taller than the fixed-580 `/onboard` preview frame
  (`OnboardingPreview.tsx`), so the preview misrepresents the real layout. Fix:
  one shared `ONBOARDING_SIZE` constant (height ≥ minHeight) used by both, or
  lower `minHeight`.
- [ ] **Dev routes ungated in prod (#9):** `/onboard` (and `/gallery`) routes +
  their Sidebar entries have no `import.meta.env.DEV` guard, so end users can
  open the design preview / component gallery. Gate behind DEV. (Also in §4 P2.)
  Relatedly, `OnboardingDialog` is now dead in-app (App.tsx dropped its only
  usage) and survives only via `GalleryPage` — delete it if the new flow fully
  replaces it.
- [ ] **`folderName` duplicated (cleanup):** `OnboardingLauncher.tsx`
  re-implements the identical `folderName(path)` from `VaultLauncher.tsx` (same
  regex + fallback). Export one and reuse so they can't drift.

---

## 2. Security lockdown (done — reworked per the Claude Code SDK docs)
- [x] **Secret reads via permission rules.** The SDK is explicit that the sandbox
  `filesystem.denyRead` only confines subprocesses — the in-process `Read`/`Glob`
  tools obey PERMISSION rules. So secrets are now blocked by `Read(~/…)`/`Edit(~/…)`
  deny rules (`secretDenyRules()`), with the sandbox `denyRead` kept as the
  subprocess backstop (`Grep`/ripgrep, `Bash`). ~/.ssh, ~/.aws, ~/.gnupg,
  ~/.config/{gh,gcloud}, ~/.kube, ~/.npmrc, the app token store.
- [x] Network egress blocked (`allowedDomains: []`) + `Bash(curl|wget|nc|…)` deny
  rules; `allowUnsandboxedCommands: false` closes the `dangerouslyDisableSandbox`
  escape. Settings toggle ("Protect secrets & block data exfiltration", default on).
- [x] Capture/intake least-privilege builtins (Read/Glob/Grep, no Bash) AND
  `allowDelegation: false` so the sidecar can't re-add `Task`/`Skill` and let
  injected content delegate to a full-toolset subagent.
- [x] **Verified live** (`sidecar/scripts/verify-secret-lockdown.mjs`, 2026-07-08):
  under bypassPermissions the model's `Read` of a sentinel secret is blocked by
  the deny rule — PASS (Read attempted, sentinel not leaked).
- [ ] Confirm the OS sandbox actually initialises in the **packaged** app (dev uses
  raw sidecar; release uses `sidecar-pkg`). Then flip `failIfUnavailable: true`
  for a hard guarantee (currently false so a sandbox that can't start degrades to
  the permission-rule layer instead of breaking chat).
- [ ] Broaden the secret list (.env, *.pem, custom key paths) OR switch to a
  vault-whitelist model (deny all of `~/`, allow only the vault) so no list needs
  maintaining. See memory `reference_claude_code_sandbox_security_model`.

## 3. Save safety (done — reliability rework this session)
- [x] `saveFailureStore` + cause-classified toasts + unsaved-changes quit gate.
- [x] Checkpoint flush on blur / visibilitychange / doc-switch.
- [x] **Declarative save-failure toast:** store is the single source of truth; a
  level-triggered reconciler maps state→toast (show/update-cause/dismiss), and
  the live toast is `dismissible:false`. Fixes: dismissed-toast-never-returns
  (silent data loss), stranded failure entries (now pruned by an end-of-pass
  `reconcile(dirtySlugs)` keeping `failures ⊆ dirty`), stale cause copy. Unit
  tested (`saveFailureStore.test.ts`). (commits `0df05184`)
- [x] **Quit gate keyed on real write failures**, not the raw dirty set — a slug
  stays dirty for benign reasons (conflict / not-ready / deferred), which used to
  false-fire the "couldn't be saved" dialog and block quit. (commit `c4b849db`)

---

## 4. Launch-readiness audit — still open (from the 5-agent review)

### P0
- [ ] **AI whole-doc write clobbers concurrent typing** (`CmEditor.tsx:266`,
  `applyIngest.ts`). INVESTIGATED — deferred: narrow (closed-note whole-doc
  write across an await window) and the fix touches the untested apply pipeline
  where `md` and `change.edits` aren't guaranteed coupled → a wrong fix corrupts
  docs. Do with a CM-view test harness, not on launch eve.

### P1 (soon)
- [ ] Version is `0.0.1` in package.json / tauri.conf.json / Cargo.toml — bump
  to a real launch version and cut one signed release to prove the updater.
- [ ] No telemetry / crash reporting / on-disk log — add a rolling log file.
- [ ] `pnpm lint` fails (exit 1) — `scripts/check-font-sizes.mjs` needs Node
  globals in the ESLint flat config (~2 lines). App code lints clean.
- [ ] Anchor-fail accept reads as success (`pendingChangesApplier.ts:376`).
- [ ] `bodyMarkdown` lost-update (no per-slug lock); vaultWatcher reload TOCTOU.
- [ ] Fable-5 selectable but `stop_reason:'refusal'` unhandled.
- [ ] `fetch_url.rs` SSRF: redirects not re-validated per hop; fs/asset scope is
  `$HOME/**` (narrow to vault + app-data).
- [ ] `appendVaultFile` non-atomic truncating write (chat JSONL) → atomicWrite.
- [ ] `useClaudeAuth` never re-polls → stale "connected" state.

### P2 (cleanup)
- [ ] Highest-risk modules untested: `streamParser.ts`, `pendingChangesApplier`,
  `chat/index.ts`.
- [ ] Prod-path `console.log` (~25), `/gallery` + `/onboard` routes ungated in
  prod, `probe.html` present, `src/prototypes/` misnamed (load-bearing).

---

## Next suggested step
Polish P2 Connect (real OAuth wiring) OR editor-side P3/P4 (empty-state + JIT
connect — closes the original onboarding bug). Then version bump + lint (quick
launch wins).
