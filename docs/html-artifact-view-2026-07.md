# HTML artifact view — decisions and the spike that settled them

2026-07-30. Nothing is implemented yet; this is the measured ground the
implementation should stand on.

The idea: a model that already writes HTML as a first-class output (this repo
has `docs/wiki-explainer.html` and `docs/wiki-system-deep-dive.html`) should be
able to drop an artifact into the vault and have the app render it, interactive,
instead of the app treating it as an unpreviewable blob.

## Decisions

1. **HTML is a separate file in the vault, not markdown content.** Rendered by
   the `/file/:rel` route, alongside images and PDFs. Rejected: an inline
   ` ```html ` fence rendered as a CodeMirror widget — it puts executable code
   inside a `.md`, which costs the vault's portability, and multiplies the CM
   widget lifecycle by the iframe lifecycle for no gain.
2. **Interaction is confined to the frame.** Tabs, filters, collapsing, chart
   hovers. The frame does not talk to the app. A `postMessage` intent bridge is
   a later, separate decision — it would be a new write path, and write paths
   outside the review discipline are what the auto-accept loss bug was.
3. **Scripts are allowed, and the frame is isolated instead.** `asset:`-loaded
   iframe with `sandbox="allow-scripts"` and deliberately NO
   `allow-same-origin`. Consequence: artifacts must be single-file (inline CSS
   and JS, data-URI images).
4. **The model writes the file itself** — `Write`/`Edit` turned on, with a deny
   rule keeping `.md` host-owned. No per-artifact review card: a 500-line HTML
   diff is not something a human reads, so the unit of approval is the rendered
   result, and the recovery mechanism is git.
5. **In-frame state is not persisted.** It dies with the frame. Follows from 2.
6. **The view auto-refreshes** when the file changes on disk.

## What the spike measured

Four probes, all against the real thing. Two are still in the tree
(`sidecar/scripts/probe-md-write-deny.mjs`, `probe-md-deny-holes.mjs`); the
frontend one was a gated boot hook (`VITE_HTML_SPIKE`) plus a probe HTML in the
vault, both removed after the run. Raw output of the last two runs is quoted
below rather than summarised, because two of the five findings are the kind that
get "remembered" wrong.

### The iframe (decisions 2 and 3)

Measured twice, because this repo has been burned by dev-vs-bundle divergence
before (IME). **`tauri dev` has no app CSP at all** — the page is served by Vite
over `http://localhost:1420`, so Tauri cannot attach the header; the probe
recorded `cspActive: false` there and `cspActive: true` at `tauri://localhost`
in a `--debug` bundle. Any CSP claim measured in dev is worthless.

| | dev | bundle |
|---|---|---|
| script inside an `asset:` iframe runs | yes | yes |
| no sandbox → reads a vault `.md` | **LEAKED** | **LEAKED** |
| `sandbox="allow-scripts"` → script still runs | yes | yes |
| `sandbox="allow-scripts"` → vault read | `TypeError: Load failed` | `TypeError: Load failed` |
| `sandbox="allow-scripts"` → `localStorage` | `SecurityError` | `SecurityError` |
| `srcdoc` inline script | runs | **never ran (timed out)** |

### The privileged channel (the one the first run missed)

The table above measures `fetch`, which says nothing about Tauri's own bridge.
Tauri injects `__TAURI_INTERNALS__` through an init script, and on WKWebView
init scripts can be delivered to subframes; an opaque origin does not remove an
injected global. If the bridge were present, an artifact would call
`invoke('plugin:fs|read_text_file', …)` and read anything — a route
`assetProtocol.scope` does not bound. Measured in a `--debug` bundle, in BOTH
the sandboxed and un-sandboxed frame:

```
tauriInternals : "undefined"      suspectGlobals : "none"
tauriGlobal    : "undefined"      invokeResult   : "no-invoke-function"
topAccess      : "THREW:SecurityError"
parentTauri    : "THREW:SecurityError"
```

`suspectGlobals` scanned every own property of `window` matching
`/tauri|ipc|invoke|__TAURI/i`, so this is not just two known names coming back
absent. The cross-origin `SecurityError` on `window.top` / `window.parent` is
what closes the second route: `asset://localhost` is a different origin from
`tauri://localhost`, so the frame cannot borrow the host's bridge either — which
is why even the *un-sandboxed* arm is walled off from IPC.

Three things to keep:

- **The leak is real, not theoretical.** `assetProtocol.scope` is `$HOME/**`, so
  an un-sandboxed artifact frame fetching
  `asset://localhost/<encoded vault path>/note.md` gets the file. The sentinel
  came back. Isolation is load-bearing, not ceremony.
- **`srcdoc` is not an option for anything interactive.** It inherits the parent
  CSP, so `script-src 'self'` with no `unsafe-inline` stops its script dead —
  which is exactly why it ran in dev (no CSP) and not in the bundle. It stays
  viable only for static HTML.
- **The single-file constraint is not the sandbox's fault.** A *relative* fetch
  (`./sibling.md`) fails with 403 even with no sandbox, because the asset URL
  encodes the whole path as one segment and relative resolution lands outside
  the scope. So a multi-file artifact was never going to work here.

No CSP change is needed: `frame-src` already lists `'self'` and `asset:`.

### The `.md` deny rule (decision 4)

`Edit(**/*.md)` in `settings.permissions.deny`. Arms, disk state as the verdict:

| rules | `note.md` | `report.html` |
|---|---|---|
| `[]` (negative control) | overwritten | written |
| `Edit(**/*.md)` | blocked | written |
| `Edit(<vault>/**/*.md)` | **overwritten** | written |
| `Edit(**/*.md)` + Bash `printf > note.md` | blocked | — |
| `Edit(<realpath>/**/*.md)` | blocked | — |

- **An `Edit` deny does reach the `Write` tool.** `security.mjs:67-74` has always
  asserted this ("an `Edit` deny to every write tool") and nothing had measured
  it — the secret harness only ever exercised `Read`. It holds.
- **Deny wins under `bypassPermissions`,** which is the chat default. This was
  the precondition for the whole plan, since `canUseTool` is skipped in that mode
  (`server.mjs:1123-1124`).
- **A Bash `>` redirect is blocked too.** `security.mjs:70-72` claims only the
  file commands Claude Code recognises (`cat`/`head`/`sed`) are caught; the real
  boundary is wider. Worth knowing, because `Bash` is already enabled — meaning
  the model can already write vault files today, so turning `Write` on is not a
  new capability class, just an ergonomic one.
- **Use the relative glob, not an absolute path.** The absolute arm failed and it
  was NOT a grammar problem: macOS resolves `/var` to `/private/var`, so a rule
  written against the `mkdtemp` path missed the realpath the tool saw. The same
  rule against the realpath held. An absolute rule silently stops matching if the
  vault sits behind a symlink; `Edit(**/*.md)` cannot.

## Where the artifact lives

**The app does not know.** Rendering is decided by extension, never by path — so
the folder is a `CLAUDE.md` convention the user can change without a code change,
which is the standing rule for this product (the app supplies structure, the
conventions live in text).

The recommended default is `writing/`. It is the only choice that costs zero
code: `isUserVisibleCommit` (`gitStore.ts:159`) has its own `USER_PATH_PREFIXES`,
so an artifact anywhere else produces a commit that never surfaces as an activity
card — and with no approval card, an invisible commit is an invisible undo. Not
`inbox/`: that is where unfiled incoming captures wait, and an artifact is a
finished output, not something awaiting triage.

## Implementation plan

Ordered. Steps 1–4 are the viewer and contain **no policy change**; step 5 is the
only security-relevant commit and lands last so it is independently revertable.

Deliberately cut from the first landing: any `</html>` completeness gate (it
costs a full `readVaultBinary` per event and destroys the one good property of
the `asset:` path — bytes never cross IPC; a truncated frame self-heals on the
next bump), a `blob:` fallback or any CSP change, `fs:allow-stat` / mtime, an
artifact-specific route or component, size guards, in-frame state persistence,
extra sandbox tokens.

### 1. The viewer — ONE commit, four files

Splitting this commit silently bricks every `.html`: `FileViewer`'s render is an
`if/else` ladder, not a switch, so widening `AssetKind` without adding the branch
leaves `kind !== 'other'` true, no branch matching, and the file rendering
**"Loading…" forever** with no type error.

- `src/lib/attachments.ts` — `AssetKind` += `'html'`; `EXT_KIND` gets `html`,
  `htm`. `isAttachmentFile('x.html')` is already true and `/file/:rel` already
  routes, so nothing else is needed for the file to be reachable.
- `src/layout/FileViewer.tsx` — a branch cloning the pdf iframe (`:117`) verbatim
  plus `sandbox="allow-scripts"`. Do **not** route through the `text` loader:
  `asset:` streams from disk and never crosses IPC, which is what makes artifact
  size a non-issue.
- `src/chat/PromptInput.tsx:209` — `Record<AssetKind, …>`, this one *does* fail to
  compile, which is how you find it.
- `src/layout/FolderTree.tsx:516` — `attachmentIcon`'s switch has a `default:`, so
  it silently keeps the generic icon. Must be edited by hand.

Verify: unit test `classifyAsset('x.html') === 'html'` in the existing
`attachments.test.ts`, failing first. Then the real app with a hand-placed
artifact — a script-driven DOM mutation appears, `localStorage` throws
`SecurityError`, a fetch of a sibling `.md` fails, and nothing renders as
"Loading…".

### 2. Revision store

New `src/state/artifactRevisionStore.ts`: `Record<rel, number>`. Shape from
`src/state/pageHeaderStore.ts` (24 lines); path-keyed immutable-copy discipline
and the non-hook accessor from `src/state/externalConflictStore.ts:37-63`.
Exports `bumpArtifactRevision(rel)` (non-hook, for the watcher) and
`useArtifactRevision(rel)`.

### 3. Watcher branch + git, one commit

`src/lib/vaultWatcher.ts`, inserted between `:126` and `:134` — i.e. after
`toVaultRelative` and **before** the `candidates.length === 0` return that
currently kills `.html`. New exported `isWatchableArtifactFile(rel)` mirroring
`isWatchableBodyFile`'s dot-segment rule (exported so the test calls the
product's predicate instead of restating it). Do **not** widen
`isWatchableBodyFile`: everything downstream assumes a slug-bearing `.md`.

- **Trailing debounce, own timer, per path** — mirror `scheduleFolderRefresh`'s
  shape (`:75-86`). Claude Code's `Write` is truncate-then-write and macOS
  fsevents emits several `modify` events per write, so an un-debounced bump
  renders a half-written file.
- **Skip the bump on `remove`** — an artifact deleted while open would remount on
  a missing file, and an `<iframe>` surfaces no error for a 404, so the user gets
  a blank frame rather than the existing `Fallback`. Keep the last good render.
- **Call `useGitStore.getState().noteActivity(rel)` directly.** `git_commit` does
  `git add -A` (`src-tauri/src/git.rs:513`), so the artifact is already captured
  by any commit that fires — the only gap is that none fires, because the
  turn-end checkpoint gates on `dirtyPaths.size > 0` (`chat/index.ts:433`) and
  `dirtyPaths` is fed only by `noteActivity`.
- **Do not widen `ACTIVITY_PREFIXES`.** It feeds `isActivityPath`, so widening it
  makes every external `.md` — including `threads/` and `_system/` churn —
  populate `dirtyPaths` and fire a spurious `organize(ai)` commit at the end of
  essentially every turn.
- Note the branch sits inside `isActionableEvent`, which drops
  `modify.kind === 'metadata'`: a truncate+write produces a data modify but a
  `touch` does not, so do not test this with `touch`.

Verify, in the real app: `printf` a change and the frame updates in about a
second; five writes inside 200 ms produce **one** bump; `dirtyPaths` contains the
rel and the next turn end yields a commit whose `git log --stat` shows the
`.html`.

### 4. Keyed remount

`FileViewer.tsx`: `key={`${rel}#${rev}`}` on the artifact iframe. **Not** a `?v=`
query param — asset URLs pct-encode the whole path as one segment (measured
above), so a query string may be swallowed into it and 403. A fresh element with
the same `src` is the thing to try first.

Verify: this step's only real question is whether WKWebView re-fetches or serves
the cached asset response. If stale, contingency A is `?v=` while watching for a
403, contingency B is a `blob:` URL with a `frame-src blob:` CSP addition. Build
neither speculatively.

### 5. Sidecar policy — last, independently revertable

One prerequisite measurement, then one commit.

**Measure first:** is the relative glob cwd-relative or path-global? Same probe
harness, `cwd` = vault, rule `Edit(**/*.md)`, Write target an absolute path in
`tmpdir()` outside cwd. Allowed → cwd-relative → ship `Edit(**/*.md)`. Blocked →
path-global → use an absolute rule built with `realpathSync(vaultPath)` (measured
to hold), and make the assembly fall back to the relative form when `vaultPath`
is absent — otherwise a no-vault harness silently loses `.md` protection, which
is exactly the failure class the `sandboxEnabled` bug produced.

Then: new exported rule builder in `sidecar/src/policy/security.mjs`, spread into
the deny list at `sidecar/src/server.mjs:1080-1082`, `'Write'` added to
`builtinTools` at `src/agent/chat/index.ts:1026`, and a kept
`sidecar/scripts/verify-md-write-deny.mjs` modelled on
`verify-deny-rules-unconditional.mjs` that **imports the builder** rather than
restating the rule, run against the un-denied code first and observed to FAIL.

`Write` and the deny must be the same commit. The E6 omission exists so that
disk-changing intent routes through `propose_*` and gets a review card; with
`Write` present under `bypassPermissions`, the deny is the only thing left
stopping the model from preferring `Write` over `propose_edit` on a `.md`. It is
load-bearing, not defense-in-depth.

Plan mode is not a conflict, and the earlier worry was inverted: plan turns pass
an explicit array at `useChatRunner.ts:355` that **already includes `Write`**, and
`PLAN_MODE_INSTRUCTIONS` never asks the model to write a plan file (the plan
travels in `ExitPlanMode.input.plan`, per the comment at `server.mjs:310-313`).

### 6. Convention

Vault `CLAUDE.md` / system prompt: artifacts go in `writing/`, and must be a
single file — inline CSS and JS, data-URI images. The single-file rule is not a
preference; a relative sibling fetch 403s regardless of sandbox.

## Accepted residual risks

- **No CSP applies inside the frame.** `asset:` responses carry no CSP header and
  the parent's CSP does not reach a child document, so an artifact has
  unrestricted network egress — it can load remote scripts and POST anywhere. The
  sandbox blocks vault *reads*, not exfiltration. With prompt-injectable note
  content upstream this is the real residual exposure. Not closable in v1;
  comment it rather than pretend otherwise.
- **`allow-same-origin` must never be added** to the sandbox attribute — it
  restores the measured leak. Worth a comment at the call site.
- **No `allow-modals` / `allow-popups` / `allow-forms`,** so `alert`/`confirm`,
  `window.open` / `target=_blank`, and form submits silently do nothing. An
  artifact that uses them looks broken.
- **In-frame state loss is irreducible,** and the artifact cannot even
  self-persist: `localStorage` throws under the opaque origin. Document, build
  nothing.
- Compact mode's early return in `EditorHeader.tsx:93-124` never renders
  `FileViewerHeaderTitle`, so an open artifact shows no header title there.
  Pre-existing, not a regression from this work.

Not answered, deliberately deferred: an artifact bakes its data in at generation
time, so it goes stale when the source note changes, with no indication. Whether
that matters depends on whether artifacts get used as one-off outputs or as
standing dashboards — worth seeing before building for it.

Known consequence, accepted: auto-refresh remounts the frame, so in-frame state
resets whenever the model rewrites the file. Debounce on settle (~400ms) and
reload only when the content hash actually changed.

Not answered, and deliberately deferred: an artifact bakes its data in at
generation time, so it goes stale when the source note changes. For now it just
goes stale.
