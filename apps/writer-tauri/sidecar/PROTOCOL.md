# Sidecar Protocol

The Tauri Rust process and the Node sidecar communicate over the sidecar's
stdin/stdout using **LSP-style framing** with **JSON-RPC 2.0** payloads.

This document is the source of truth. The sidecar implementation, the Rust
bridge, and any test client must conform to this spec.

---

## 1. Transport

### Framing (LSP-style)

Every message is preceded by HTTP-like headers terminated by `\r\n\r\n`.

```
Content-Length: 84\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientVersion":"0.1.0"}}
```

- `Content-Length` is **mandatory** and counts the exact byte length of the JSON
  payload (no trailing newline).
- Other headers are ignored by the parser.
- Payload encoding: UTF-8.

### Why framed (not newline-delimited)

JSON values can contain literal newlines inside strings (rare but legal). LSP
framing eliminates ambiguity and matches the dominant industry pattern (LSP,
MCP). Implementation cost is negligible (~30 lines).

---

## 2. JSON-RPC 2.0 Conventions

We use the standard subset: requests, responses, and notifications.

**Request** (expects a response):
```json
{"jsonrpc":"2.0","id":1,"method":"chat","params":{...}}
```

**Response** (success):
```json
{"jsonrpc":"2.0","id":1,"result":{...}}
```

**Response** (error):
```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"BUSY","data":{...}}}
```

**Notification** (no response expected, no `id`):
```json
{"jsonrpc":"2.0","method":"chat/event","params":{...}}
```

### ID rules

- Requests carry `id` (integer or string). Responses echo the same id.
- Notifications must omit `id`.
- The Rust bridge generates request ids; the sidecar never generates ids for
  client-bound traffic — server-pushed events go out as notifications only.

### Direction

- **Rust → sidecar**: requests and notifications (cancel notifications).
- **sidecar → Rust**: responses (matched by id) and notifications (`chat/event`,
  `chat/done`, `chat/error`).

---

## 3. Methods (Rust → sidecar)

### `initialize`

Handshake. Must be the first request after spawn. The sidecar is in an "uninitialized" state until this completes — all other requests return `-32002 NOT_INITIALIZED`.

**params**:
```json
{
  "clientVersion": "0.1.0"
}
```

**result**:
```json
{
  "protocolVersion": 1,
  "sidecarVersion": "0.1.0",
  "sdkVersion": "0.2.121",
  "node": "v20.11.0"
}
```

`protocolVersion` is asserted by the host (see §9). `params.protocolVersion`
carries the host's expected version; `sidecarVersion`/`clientVersion` remain
advisory (telemetry only).

---

### `setToken`

Inject or rotate the OAuth access token. Must be called at least once before
the first `chat`. May be called again any time to rotate (e.g. after refresh).

**params**:
```json
{
  "token": "sk-ant-oat01-..."
}
```

**result**: `null`

**errors**:
- `-32602 INVALID_PARAMS` — token doesn't match `sk-ant-oat...` prefix

---

### `models`

List the models the installed SDK version reports support for, so the host's
model picker stays in sync with whatever the current `@anthropic-ai/claude-agent-sdk`
actually offers (no hand-maintained model list on the host side).

**params**: `null` (or omitted)

**result**:
```json
{ "models": [ { "id": "claude-sonnet-4-6", "...": "capability flags" } ] }
```

**errors**:
- `-32002 NOT_INITIALIZED`
- `-32602 INVALID_PARAMS` — reused (rather than `NO_TOKEN`) by the current
  implementation when `setToken` hasn't been called yet; documented here as
  the actual behavior, not a claim about what it "should" be.

---

### `chat`

Start a chat turn. Streams `chat/event` notifications until either `chat/done`
or `chat/error` is sent.

The chat sidecar is **multiplexed**: multiple concurrent `chat` requests may
be in flight simultaneously, distinguished by `runId`. Cancel and event
routing are per-`runId`.

The title sidecar is **single-flight** and rejects a second concurrent `chat`
with `-32001 BUSY`.

**params**:
```json
{
  "runId": "client-uuid",
  "model": "claude-sonnet-4-6",
  "systemPrompt": "...",
  "prompt": "user message text",
  "tools": [
    { "name": "propose_change", "description": "...", "input_schema": {...} }
  ],
  "permissionMode": "bypassPermissions"
}
```

- `runId` is a client-provided correlation id surfaced on every related
  notification. Distinct from the JSON-RPC `id` on the request itself.
- `tools` is optional. If omitted, no tool definitions are passed to the SDK.
- `permissionMode` defaults to `"bypassPermissions"` (we do not use the SDK's
  built-in permission UI; the Tauri host manages user consent).

**result** (immediate, not a stream):
```json
{ "runId": "client-uuid", "accepted": true }
```

The actual streaming happens via subsequent `chat/event` notifications keyed
by `runId`.

**errors**:
- `-32001 BUSY` — title sidecar only: another title chat in progress
- `-32003 NO_TOKEN` — `setToken` has not been called
- `-32602 INVALID_PARAMS` — required field missing or `runId` collides with an active chat on this sidecar

---

### `chat/cancel` (notification, no response)

Aborts the chat identified by `runId`. If no chat matches, silently ignored.
Other concurrent chats on the same sidecar are unaffected.

**params**:
```json
{ "runId": "client-uuid" }
```

The active chat terminates with a `chat/error` notification carrying
`code: "CANCELLED"`.

---

### `chat/decision` (notification, no response)

Answers a parked `canUseTool` gate — `AskUserQuestion` (any permission mode)
or `ExitPlanMode` (plan mode only). Resolves the matching pending decision so
the SDK's `canUseTool` callback returns and the turn continues. Unknown or
already-settled `decisionId`s are ignored.

**params**:
```json
{ "runId": "client-uuid", "decisionId": "sidecar-minted-uuid", "decision": {"...": "shape below"} }
```

`decision`'s shape depends on which tool requested it:
- `AskUserQuestion` → `{ "answers": { "q1": "..." }, "response"?: "free-form reply" }`
- `ExitPlanMode` → `{ "type": "approve" }` or `{ "type": "reject", "message": "..." }`

Only fires for `permissionMode: "plan"` or `"default"` — never for
`"bypassPermissions"`, which short-circuits `canUseTool` entirely.

---

### `chat/edit-ack` (notification, no response)

Confirms (or denies) that a `propose_edit`/`propose_write`/`propose_multi_edit`
call was actually queued into the host's pending-changes store. The sidecar's
`PostToolUse` hook (see `chat/edit-pending` below) awaits this before letting
the model treat the proposal as settled.

**params**:
```json
{ "pendingId": "uuid from the tool's own success text", "ok": true, "reason": null }
```

**Fail-open contract**: if this is never sent (or arrives after the hook's own
~4-5s internal timeout), the hook treats the proposal as `ok: true` rather
than blocking or erroring — a missing ack is NOT itself surfaced as a failure
to the model. Only an explicit `ok: false` rewrites the tool's already-returned
"queued" text into a visible error.

---

### `shutdown`

Gracefully shut down. The sidecar finishes **all** in-flight chats with a
`CANCELLED` error, releases resources, and exits with code 0 within 1 second.

**params**: `null`
**result**: `null`

After receiving the `shutdown` response, the Rust bridge should close the
sidecar's stdin and wait for process exit.

---

## 4. Notifications (sidecar → Rust)

### `chat/event`

Wraps a single Agent SDK event from the `query()` async iterator. The bridge
forwards the inner `event` to the frontend without inspecting it.

**params**:
```json
{
  "runId": "client-uuid",
  "event": { "type": "assistant", "message": {...} }
}
```

Possible inner `event.type` values (passthrough — non-exhaustive):
- `system` (subtype `init`)
- `assistant`
- `user` (tool_result)
- `result` (subtype `success` | `error`)
- `rate_limit_event`

The frontend is the source of truth for which events it cares about. The
sidecar never filters or transforms.

---

### `chat/done`

Sent exactly once per accepted chat, after the final SDK event.

**params**:
```json
{
  "runId": "client-uuid",
  "stopReason": "end_turn",
  "usage": { "input_tokens": 3, "output_tokens": 4, ... },
  "totalCostUsd": 0.043
}
```

After `chat/done`, the sidecar is idle and ready for the next `chat`.

---

### `auth/refreshNeeded`

Sent when Anthropic rejects an in-flight chat with 401 / unauthorized. The
sidecar pauses the affected chat, emits this notification, and waits up to
5 seconds for the host to push a fresh token via `setToken`. If a new token
arrives, the chat is retried once. If retry also fails (or no fresh token
arrives in time), the chat ends with `chat/error code=AUTH`.

The sidecar cannot refresh tokens itself — it has no key-chain access. The
host owns the OAuth flow; this notification is the sidecar asking for help.

**params**:
```json
{ "runId": "client-uuid" }
```

The `runId` lets a multi-chat host distinguish which chat triggered the
refresh, even though a single new token applies to all of them.

---

### `chat/proposal`

Sent each time the model invokes a relay tool (e.g. `propose_change`). The
sidecar's tool handler immediately returns a brief ack to the model and
forwards the call's input to the host via this notification — the host
(frontend) is responsible for applying the actual side-effect (inserting
marks into the editor, etc.).

**params**:
```json
{
  "runId": "client-uuid",
  "input": { "kind": "suggestion", "quote": "...", "content": "...", ... }
}
```

The shape of `input` is whatever the relay tool's schema accepts.

---

### `chat/permission`

Sent when the sidecar's `canUseTool` gate parks on `AskUserQuestion` or (in
plan mode) `ExitPlanMode`, waiting for the user's decision. Answered by
`chat/decision` (Section 3), matched via `decisionId`.

**params**:
```json
{ "runId": "client-uuid", "decisionId": "sidecar-minted-uuid", "toolName": "AskUserQuestion", "input": {"...": "the tool's own input"} }
```

---

### `chat/edit-pending`

Sent when the model calls `propose_edit`/`propose_write`/`propose_multi_edit`.
The tool itself returns a "queued for review" success string to the model
immediately (non-blocking) — this notification is the host's cue to actually
map the proposal into its pending-changes store. Once the host has decided
whether it landed, it answers with `chat/edit-ack` (Section 3), which the
sidecar's `PostToolUse` hook uses to confirm — or, on failure, rewrite — what
the model was told.

**params**:
```json
{ "runId": "client-uuid", "pendingId": "sidecar-minted-uuid", "toolName": "Edit" | "Write" | "MultiEdit", "input": {"...": "the tool's own input"} }
```

---

### `chat/error`

Sent when a chat fails or is cancelled. Mutually exclusive with `chat/done`.

**params**:
```json
{
  "runId": "client-uuid",
  "code": "CANCELLED" | "AUTH" | "RATE_LIMIT" | "NETWORK" | "INTERNAL",
  "message": "human-readable description",
  "retryable": true
}
```

After `chat/error`, the sidecar is idle.

---

## 5. Error Codes

### JSON-RPC standard
- `-32700` Parse error (malformed JSON)
- `-32600` Invalid Request (missing `jsonrpc` or `method`)
- `-32601` Method not found
- `-32602` Invalid params
- `-32603` Internal error

### Domain-specific
- `-32001` `BUSY` — another chat in progress
- `-32002` `NOT_INITIALIZED` — `initialize` not yet called
- `-32003` `NO_TOKEN` — `setToken` not yet called
- `-32004` `INVALID_TOKEN` — Anthropic rejected the token (401 from upstream)

`chat/error` notifications use string codes (`AUTH`, `RATE_LIMIT`, etc.)
rather than numbers because they're consumed by the frontend, not the
JSON-RPC client.

---

## 6. Lifecycle

```
spawn
  │
  ▼
[uninitialized] ──initialize──▶ [no token] ──setToken──▶ [ready]
                                                            │
                                            chat (per runId) ─┐
                                                              ▼
                                                  active set: { runId₁, runId₂, … }
                                                              │
                                            each chat ends → chat/done | chat/error
                                                              │
                                                  active set shrinks → [ready] when empty
                                                              │
                                                          shutdown
                                                              │
                                                              ▼
                                                          exit 0
```

- **Chat sidecar**: any number of concurrent chats; new ones added to the
  active set as they arrive.
- **Title sidecar**: active set capped at 1; second concurrent `chat`
  returns `BUSY`.
- `chat/cancel` always allowed (idempotent if `runId` not active).
- `setToken` allowed in any post-initialize state.
- `shutdown` allowed in any state; cancels all active chats.

---

## 7. Concurrency Model

We run **two independent sidecars** with different concurrency models:

### Chat sidecar — multiplexed

Multiple `chat` requests may be in flight at the same time, each identified
by its own `runId`. Rationale:

- A single user may have several threads, and the user can press Enter in a
  second thread while the first is still streaming.
- Anthropic prompt-cache reuse depends on identical leading systemPrompt
  segments. Multiple chats over the same document share that prefix; running
  them inside the same Node process lets the SDK / API serve them from the
  same cache lineage.
- Per-`runId` cancellation is straightforward (one `AbortController` per
  active chat).

### Title sidecar — single-flight

Background title generation runs in a separate Node process. This sidecar
processes one `chat` at a time and rejects a second concurrent `chat` with
`-32001 BUSY`. The Rust host queues title requests.

Rationale: title generation is short and infrequent; isolating it from chat
keeps long-running chats and quick title calls from contending for the same
event loop, and the simpler single-flight model is enough.

### Token sharing

Both sidecars receive the same OAuth token via independent `setToken` calls.
Rotation must be applied to both.

---

## 8. Restart & Crash Semantics

If a sidecar process exits unexpectedly:

1. The Rust host marks every in-flight chat on that sidecar as failed
   (`chat/error code=INTERNAL retryable=true`). The frontend surfaces an
   inline "Reconnecting…" indicator immediately on each affected chat.
2. The host respawns the sidecar and re-runs `initialize` + the most recent
   `setToken`.
3. As long as new chats can be accepted, the indicator clears.

### Time-based escalation (not count-based)

The host tracks an "unhealthy since" timestamp, set when the first crash
happens and the sidecar isn't yet usable, cleared when a fresh sidecar
successfully accepts traffic.

- If a sidecar is continuously unhealthy for **10 seconds**, the host emits a
  user-visible modal: `Connection failed. [Retry] [Quit]`.
- [Retry] resets the unhealthy timer and respawns once.
- [Quit] triggers app shutdown.

This replaces a crash-count threshold: the user is told something is wrong
based on how long it has actually been broken, not how many internal restart
attempts have occurred.

### App-shutdown during streaming

When the user closes the app window or quits while at least one **chat
sidecar** chat is active:

1. The host shows a modal:
   ```
   A chat is in progress.
   Closing now will cancel the response.
   [Wait]   [Cancel and Quit]
   ```
2. [Wait] dismisses the modal; the app stays open.
3. [Cancel and Quit] sends `chat/cancel` for every active `runId`, then
   `shutdown` to both sidecars, then exits.

Title-sidecar activity does not trigger the modal (titles complete in <1s).

---

## 9. Versioning

Two independent version signals travel in `initialize`:

- **`protocolVersion`** (integer) — the wire-contract version, asserted for
  **exact equality**. The host sends its expected value in `params` and the
  sidecar reports its own in the result; on any mismatch the host refuses to
  use the sidecar (`ProtocolMismatch`). Client and sidecar ship in the same app
  bundle, so a mismatch is never a compatibility spread to negotiate — it means
  the bundled sidecar is stale (typically `pnpm pack:sidecar` wasn't re-run).
  Bump this integer, in lockstep on both sides (`sidecar/src/server.mjs` and
  `src-tauri/src/claude_sidecar/client.rs`), on any breaking change to the
  request/notification shapes in this document.
- **`clientVersion` / `sidecarVersion`** (semver strings) — advisory only, used
  for telemetry and bug reports; never gate behavior.
