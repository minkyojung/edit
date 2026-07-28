# Repo notes for Claude

Tauri desktop app (`apps/writer-tauri`): a markdown note editor with a chat
agent. The agent runs in a Node sidecar wrapping the Claude Agent SDK.

## Verifying a change

The agent's runtime behaviour is established by driving the real sidecar, not by
reading the code — see `apps/writer-tauri/sidecar/scripts/verify-*.mjs`. Two need
no API token and finish in seconds (`verify-lifecycle`,
`verify-git-revert-and-applied`); the rest drive a live model and want
`CLAUDE_CODE_OAUTH_TOKEN`. `apps/writer-tauri/sidecar/CLAUDE.md` maps which one
covers what.

Before keeping a new check, run it against the unfixed code and confirm it
FAILS. Checks that could not fail have shipped here more than once — one
asserted against a hand-copy of a product predicate, dropped two of its three
terms, and stayed green while the product was broken.

Which is the other half of the same rule: when a test needs a predicate or a
constant the product owns, export it and call it. Restating it in the test is
how the copy drifts.

## Sidecar

Read `apps/writer-tauri/sidecar/CLAUDE.md` before changing anything under
`apps/writer-tauri/sidecar/` — it has the build step the app depends on and two
SDK behaviours that fail silently.
