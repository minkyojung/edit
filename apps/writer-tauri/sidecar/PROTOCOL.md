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
- Each side mints ids for the requests it sends, and correlates responses only
  against ids it minted itself. **The two counters are separate namespaces and
  may overlap without ambiguity**: a frame with an id *and* a method is a
  request, a frame with an id and no method is a response.

### Direction

Both directions carry requests. The asymmetry this replaced was not a design —
a question the sidecar needed to ask was faked with a notification out, a
notification back, and a hand-rolled correlation map, once per feature.

- **Rust → sidecar**: requests (§3) and notifications.
- **sidecar → Rust**: requests (§3b), responses, and notifications (§4).

A request the receiver has no handler for is answered `-32601 method not
found`. Refusing is the point: a peer told "no" recovers, a peer ignored waits
forever — neither side puts a deadline at the transport layer, because the
transport cannot know what a given question means.

A frame with neither `id` nor `method` cannot be addressed or dispatched. The
host logs it. In practice this is the sidecar's `errorResponse(null, -32700)`
for a frame it could not parse — which means one of our requests is about to go
unanswered, so the log is the only warning that exists.

Batches (a top-level JSON array) are unsupported in both directions.

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
  "protocolVersion": 2,
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

### `shutdown`

Gracefully shut down. The sidecar finishes **all** in-flight chats with a
`CANCELLED` error, releases resources, and exits with code 0 within 1 second.

**params**: `null`
**result**: `null`

After receiving the `shutdown` response, the Rust bridge should close the
sidecar's stdin and wait for process exit.

---

## 3b. Methods (sidecar → Rust)

Questions the sidecar asks the host, as opposed to the events it announces.
They exist because the answer lives on the far side of the host: the note
catalogue is in the frontend's docs store, and a permission verdict is in the
user's head. The host parks the obligation, asks the frontend, and answers when
the frontend's own command comes back — see `claude_sidecar::pending_frontend`.

Consequences worth stating, because both are load-bearing:

- **Answers may take arbitrarily long.** The `host/permission` case waits on a
  human. The sidecar sets no transport deadline; a caller that needs one adds
  it itself.
- **An answer is guaranteed, including on the sad paths.** If the run is
  cancelled or the sidecar restarts, the host releases the parked request and
  the caller sees `-32603` rather than waiting on a reply nobody will send.

### `host/queryNotes`

Filter the note catalogue by metadata and return references only. Backs the
`query_notes` relay tool.

**params**: `{ runId, where: { status?, tags?[] }, limit, cursor }`
`runId` is required — it is what the host parks the request under, so a
cancelled run can release it.

**result**: `{ results: [{ path, title, status, tags }], nextCursor }`
`results` is always an array; the host's command boundary rejects anything else.

### `host/editPending`

Stage a `propose_edit` / `propose_write` / `propose_multi_edit` proposal and
report whether it took. Backs all three propose_* tools.

**params**: `{ runId, pendingId, toolName: "Edit" | "Write" | "MultiEdit", input }`
`pendingId` is the review card's identity, minted by the sidecar. The host
parks the request under it rather than minting a second token, because the
frontend already carries it end-to-end.

**result**: `{ ok, reason, applied }`
`ok: false` means nothing was queued and the file is unchanged; `reason` is
shown to the model so it can rewrite. `applied: true` means auto-accept mode
wrote it straight to disk and there is no review card.

**The result IS the tool's result.** The handler blocks on it and returns text
chosen by the verdict — there is no optimistic "queued" for a later signal to
correct. That correction used to be a `PostToolUse` hook, which landed ~2/3 of
the time; a refusal that missed left the model seeing an unchanged file, so it
proposed the same edit again and the user got two cards for one edit.

**Silence and refusal are different.** The caller fails OPEN after 15s of
silence, because silence means a wedged host and a lost ack must not wedge the
turn too. An explicit error response does not get that benefit — the host sends
one when it releases a request, and a released request genuinely did not queue.

### `host/permission`

Park a `canUseTool` gate — `AskUserQuestion` (any permission mode) or
`ExitPlanMode` (plan mode only) — until the user answers. Never fires for
`bypassPermissions` on anything but `AskUserQuestion`, which the SDK does not
short-circuit.

**params**: `{ runId, decisionId, toolName, input }`
`decisionId` keys the frontend's permission card and is quoted back, so the
host parks under it.

**result**: the decision, shaped by which tool asked:
- `AskUserQuestion` → `{ answers: { "<question text>": "<option label>" }, response?: "free-form" }`
- `ExitPlanMode` → `{ type: "approve" }` or `{ type: "reject", message }`

Answers are keyed by the question TEXT, and nested under `decision` at the
Tauri command boundary (`QuestionPanel.tsx`). Sent flat, the turn resumes and
the model reports the question went unanswered — which reads exactly like a
product bug and is not one.

**This is the request with no deadline at either end.** A human is answering;
five seconds and five minutes are both ordinary. The only thing that unparks it
besides an answer is the turn being cancelled, which the sidecar carries into
the transport as an abort signal so the pending slot is abandoned rather than
left waiting on a reply nobody will send.

---

## 4. Notifications (sidecar → Rust)

The Rust bridge forwards every namespaced notification to the frontend as a
Tauri event by a mechanical rule — `chat/<x>` → `claude:<x>`, any other
`<ns>/<x>` → `<ns>:<x>` — passing `params` through untouched. Adding a channel
therefore needs no bridge change, and an unexpected method is logged rather
than dropped. The sole exception is `auth/refreshNeeded`, which the bridge
consumes itself (token refresh) and never forwards.

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

### History

| version | change |
|---|---|
| 1 | initial contract |
| 2 | Every question the sidecar asks the host became a real request (§3b). `chat/query-notes`+`chat/query-result` → `host/queryNotes`; `chat/edit-pending`+`chat/edit-ack` → `host/editPending`; `chat/permission`+`chat/decision` → `host/permission`. A stale sidecar on either side of this leaves those three features broken while everything else appears to work, which is exactly the failure the equality assert converts into a startup error. |
