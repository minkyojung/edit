# What we assume about the Claude Agent SDK

Every row was measured against a live CLI, not inferred from the types — several
of these are the opposite of what the type surface suggests. Each names the
version it was measured on and the check that would fail if it stopped being
true.

Current: `@anthropic-ai/claude-agent-sdk` **0.3.220** / bundled CLI **2.1.220**
(pinned in `package.json`; the CLI version rides along with the SDK).

| assumption | measured | pinned by |
|---|---|---|
| `effort` changes mid-session through `applyFlagSettings({ effortLevel })`. There is no `setEffort`, and its absence reads as "effort is fixed" — it isn't. | 2.1.220 | `verify-effort-midthread` |
| `background_tasks_changed` carries every live background task with REPLACE semantics. A level signal, so a missed event cannot wedge it. | 2.1.220 | `verify-lifecycle` T9 |
| A **blocking** subagent emits `task_started` and never a terminal event, so edge-pairing leaks its id forever. It emits no `background_tasks_changed` at all. | 2.1.220 | `verify-lifecycle` T9 (negative case) |
| The OS sandbox denies a *subprocess* read of a secret. `cat` never reaches it — the permission layer refuses that first, identically with the sandbox on and off. | 2.1.220 | `verify-sandbox-confinement` |
| Secret deny rules apply whether or not the sandbox is enabled. | 2.1.220 | `verify-deny-rules-unconditional` |
| `systemPrompt` is resolved once, at thread creation, and silently dropped on later turns. | 2.1.187 | `verify-current-note-switch` (indirect: it passes only because the per-turn user message wins over a stale system prompt) |
| Hooks stop firing once the prompt async-iterable returns, because the SDK then closes stdin. Our generator parks forever, so hooks DO fire per turn here. | 2.1.220 | **unpinned** |
| Plan mode is enforced by `permissionMode` (applied per turn), not by the frozen `builtinTools` list — so the frozen tool list is not a hole. | 2.1.220 | **unpinned** |
| `AskUserQuestion` reaches `canUseTool` under **every** permission mode, including `bypassPermissions` — despite the runtime warning that the callback "will not be invoked" there. It asks the host to render UI, which no mode can auto-answer. | 2.1.220 | `verify-ask-gate` arm B |

`unpinned` means we measured it once and nothing would tell us if it changed.
Worth a check the next time either area is touched.

## Pinned upstream defects

These assert behaviour we do **not** want, so that an upstream fix makes the
check FAIL. That failure is the notification.

- **`interrupt()` kills in-flight background subagents.** The CLI links each
  task's AbortController as a child of the turn's, so the interrupt cascades.
  A regression from 0.2.140; [claude-agent-sdk-typescript#352], still open on
  2.1.220. No opt-out exists — `backgroundTasks()` does not shield a task, and
  detached `run_in_background` shells survive only by being separate OS
  processes. Pinned by `verify-persistent` scenario 5.

## Upgrading

1. Run the whole suite and record the results.
2. Bump the version in `package.json`, `pnpm install`, `pnpm pack:sidecar`.
   **No code changes in that commit** — so any behaviour difference is
   attributable to the upgrade alone.
3. Re-run and diff against step 1. Investigate only what moved.
4. If a pinned defect above now fails, upstream fixed it: restore the assertion
   to the behaviour we actually want and delete the pin.

[claude-agent-sdk-typescript#352]: https://github.com/anthropics/claude-agent-sdk-typescript/issues/352
