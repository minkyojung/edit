# Sidecar notes

Wraps the Claude Agent SDK and speaks JSON-RPC to the Rust host. One long-lived
`query()` per chat thread; each turn is pushed into it and the input generator
parks between turns.

## Build

`src/` is the source. `sidecar-pkg/` is a build artifact (gitignored). Which one
the app loads depends on the build, and this used to be written here as if
`sidecar-pkg` were always it:

- **`tauri dev`** spawns `sidecar/src/index.mjs` directly (`manager.rs`, under
  `#[cfg(debug_assertions)]`). An edit to `src/` is live on the next app
  restart — no packing, and packing does not make it any more live.
- **A release build** loads `sidecar-pkg/`, so an edit to `src/` changes nothing
  there until `pnpm --filter writer-tauri pack:sidecar`.

The log line at startup says which one you got:
`args: [".../sidecar/src/index.mjs"]` vs a path under `sidecar-pkg`.

## Two things that fail silently

**Never let the prompt async-iterable return.** `#threadInput` loops forever and
parks on purpose. If it finishes, the SDK closes stdin to the CLI, and from the
next turn on every hook and permission callback silently no-ops — no error, and
tools still run, so nothing looks wrong. (SDK issues #376 / #348, open.) A
throwaway probe that yields twice and exits will show you "hooks only fire once"
and send you chasing the wrong thing; the product does not have that bug.

**Chat params split into per-turn and fixed-at-creation.** Only the four the SDK
exposes a live control for can change mid-thread — model, permissionMode,
fastMode, effort. The rest are read once when the thread's query is built and
silently dropped thereafter; a later turn that changes one now logs
`[sidecar frozen-param]`. The full split, and why each side is where it is, is at
`#applyThreadControls` in `src/server.mjs`. Corollary: anything that tracks where
the user IS (open note, selection, viewed file) belongs in the per-turn user
message, never the system prompt.

## Verification map

Everything except the first two needs `CLAUDE_CODE_OAUTH_TOKEN`.

| script | covers |
|---|---|
| `verify-lifecycle` | thread lifecycle, LRU eviction, busy/reap predicate, the prompt generator never finishing — fake SDK, no token |
| `verify-session-id` | a thread id the CLI would reject still runs (the boundary normalises it) |
| `verify-turn-queue` | a turn sent mid-answer is accepted and runs after, not concurrently |
| `verify-git-revert-and-applied` | git revert + applied-edit signalling — no token |
| `verify-persistent` | multi-turn reuse, cancel, background survival, pinned defect #352 |
| `verify-ask-gate` | AskUserQuestion parks the turn and the answer reaches the model, twice on one thread; plan-mode enforcement |
| `verify-background-classification` | which work keeps a thread alive |
| `verify-effort-midthread` | a settings change reaching later turns |
| `verify-current-note-switch` | per-turn note / selection / viewed-file context |
| `verify-sandbox-confinement` | OS sandbox: subprocess reads and network egress |
| `verify-secret-lockdown` | permission deny rules on the file tools |
| `verify-deny-rules-unconditional` | deny rules hold with the sandbox off |
| `verify-sandbox-git-write` | the vault's git repo stays writable inside the sandbox — but its `hooks/` and `config` do not |
| `verify-edit-roundtrip` | `propose_edit` reports its outcome back to the model |
| `verify-stale-retry` | whole-doc stale → model rebase loop |
| `verify-query-notes` | `query_notes` tool and its data-carrying relay |
| `verify-ask-when-forked` | AskUserQuestion only on a genuine fork |
| `verify-uncertainty-disclosure` | the least-confident line on non-trivial edits |
| `verify-reject-preference` | a rejected edit promoted to a preference |
| `verify-profile-ondemand` | profile Background loaded on demand |
| `verify-profile-title` | the title sidecar's one-shot transport |

## SDK assumptions

`SDK-ASSUMPTIONS.md` — what we believe about the SDK, the version each was
measured on, and which script would fail if it changed. Re-run it on upgrade.
