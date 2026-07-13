// Octave's internal vault namespace.
//
// Everything the app writes into the user's vault that the user should
// NOT see or edit — chat session JSON, chat attachment binaries — lives
// under a single dot-prefixed folder, `.octave/`. Dot-prefixed so:
//   - scanVault's hidden-entry filter keeps it out of the catalog/tree,
//   - the vault watcher's dot-segment filter ignores its churn,
//   - Finder hides it, and
//   - one `.gitignore` line (`.octave/`) keeps it all out of history.
//
// NOT moved here, on purpose:
//   - `_system/` — agent-managed markdown (skills / commands / personas /
//     conventions). It's a load-bearing Claude Code SDK plugin root
//     (sidecar registers `_system/agent` as a local plugin) and is
//     semi-user-facing (inspectable/editable), so it stays a visible,
//     underscore-prefixed tier of its own.
//   - `*.meta.json` sidecars — co-located next to each note by design.
//
// No legacy migration path: the pre-`.octave/` layout (`threads/`,
// `.attachments/` at the vault root) shipped only to a single dev vault
// whose history is disposable, so those folders are simply deleted by hand
// rather than moved. New installs create `.octave/*` lazily on first write.

export const OCTAVE_DIR = '.octave'
/** Chat session JSON (`<id>.json` + `<id>.turns.jsonl`). */
export const OCTAVE_THREADS_DIR = `${OCTAVE_DIR}/threads`
/** Chat attachment binaries (`<id>/<name>`), Read by the agent on demand. */
export const OCTAVE_ATTACHMENTS_DIR = `${OCTAVE_DIR}/attachments`
