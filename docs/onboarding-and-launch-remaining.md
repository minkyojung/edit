# Remaining work — onboarding redesign + launch readiness

_Last updated: 2026-07-08 (Google login + launch-hygiene pass). Branch:
`minkyojung/onboarding-sdk-deploy-prep`._

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
- [x] **P2 Connect → Google sign-in (real OAuth wiring).** Decision: P2 is now
  the *identity* step (Google one-click loopback → name/email/picture), NOT
  Claude. Claude (the AI engine) moved to JIT (see P4 below). Backend
  `google_oauth.rs` (PKCE + loopback auto-complete, profile in the token blob,
  `secure_storage`), `useGoogleAuth` hook, `ConnectPanel` rewired to
  "Continue with Google" + "Start without an account" skip, and a Google row in
  Settings → Connections. Verified live (signed in, name/email shown, disconnect
  works). Google Cloud: project `Octave-note`, Desktop client, scopes
  `openid email profile` (Gmail deferred). Client id/secret are consts in
  `google_oauth.rs` (private repo; Desktop secret is not confidential per RFC
  8252 — PKCE is the guard).
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
- [x] **P4 Connect Claude JIT** — already handled; verified 2026-07-08. Audit of
  every AI entry point found no raw-error gap: **chat** shows a full "Connect
  Claude" overlay + CTA when `!account.connected` (`ChatPanel.tsx:631`, reuses
  the sidebar `ConnectClaudeDialog`); **organize** (idle inbox pass) swallows
  failures with a `console.warn` (unprompted background — silent is correct);
  **generateAiSummary** is fire-and-forget (keeps the old sidecar value). The
  "Analyze" the original note flagged lived in the now-deleted `OnboardingDialog`
  (dead code — see §Remaining-from-code-review). Nothing to build.

### Remaining — from the code review
- [x] **Window height clamp (#10):** shared `ONBOARDING_W/H` in
  `profile/ui/onboarding/onboardingWindow.ts` (H=600 = `minHeight`), imported by
  both `OnboardingLauncher` and `OnboardingPreview` — no more clamp, preview
  matches the live window.
- [x] **Dev routes ungated in prod (#9):** `/onboard` + `/gallery` routes
  (`App.tsx`) and their Sidebar entries are now behind `import.meta.env.DEV`.
  Dead `OnboardingDialog` **deleted** (+ its `GalleryPage` showcase section).
- [x] **`folderName` duplicated (cleanup):** single `folderName` exported from
  `lib/projectWindow.ts`; `OnboardingLauncher` + `VaultLauncher` import it.

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
