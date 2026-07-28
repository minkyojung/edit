# Zed · ACP 대조 — Octave에 가져올 것

> **목적**: Zed는 Rust 기반 에이전트 호스트이고 오픈소스다. Octave와 **같은 모양**
> (네이티브 호스트 ↔ stdio JSON-RPC ↔ Claude Agent SDK를 감싼 Node 프로세스)이므로
> 비교가 직접적이다. ACP 스펙과 Zed 실제 구현을 읽고, Octave가 차용할 설계를 정리한다.
>
> **작성일**: 2026-07-28
> **읽은 소스**:
> - `zed-industries/zed` @ `a1510de54e99131f3c33c4fd86a8e71753cf08de` (main, 2026-07-27)
> - `agentclientprotocol/agent-client-protocol` @ `abb206d` (2026-07-28) — `.mdx` 스펙 + 생성된 JSON Schema
> - `agent-client-protocol` Rust crate v2.0.0 (Zed 루트 `Cargo.toml:517` 핀)
>
> **선행 문서**: `docs/rust-architecture-audit-2026-07.md` (본 문서의 항목 번호는 이 감사를 참조)

---

## 0. 먼저 — 정정

조사 중 제 초기 판단 하나가 뒤집혔다. 명시해둔다.

### 0.1 "ACP는 클라이언트가 파일을 소유한다"는 **v1 한정이고, v2에서 삭제된다**

`docs/protocol/v2/migration.mdx`:

> "v2 removes the entire v1 Client-provided execution surface: `clientCapabilities.fs` and the
> `fs/read_text_file` / `fs/write_text_file` methods; `clientCapabilities.terminal` and the
> `terminal/create`, `terminal/output`, `terminal/release`, `terminal/wait_for_exit`,
> `terminal/kill` methods."

와이어 산출물에서도 확인됨 — `schema/v2/meta.json`의 `clientMethods`는
`session/request_permission`, `session/update`, `elicitation/create`, `elicitation/complete` 넷뿐.
`meta.unstable.json`에도 없다.

삭제 사유(`docs/rfds/v2/client-filesystem-terminal-capabilities.mdx`):

> "this hasn't been widely adopted. Both because not many clients outside of IDEs could even
> offer these, and even then, **IDE support has been mixed**. Also, this requires the Agent
> tools to handle both methods, and in practice, **most stuck to their standard implementations**."

v2의 권장 대체 경로는 "클라이언트가 MCP 서버를 제공하라"인데,
그건 **에이전트가 당신의 MCP 툴을 쓸지 자기 내장 `Write`를 쓸지 고르는** 구조다.

### 0.2 v1에서조차 강제성이 없다

`fs/*`는 `overview.mdx`에서 **Optional Methods** 아래에 있고,
스펙 어디에도 **에이전트가 `fs/*`를 디스크 직접 쓰기보다 선호해야 한다는 MUST/SHOULD가 없다.**
에이전트는 로컬 서브프로세스로 유저의 파일시스템 권한을 그대로 갖는다.

`get-started/architecture.mdx`:
> "**Trusted**: ACP works when you're using a code editor to talk to a model you trust.
> You still have controls over the agent's tool calls, but **the code editor gives the agent
> access to local files** and MCP servers."

**ACP는 단일 writer를 구조적으로 보장하지 않는다.** 채널과 권한 게이트를 줄 뿐이다.

### 0.3 그런데 Octave에게는 여전히 옳다 — 이유가 다르다

ACP가 이걸 못 강제한 이유는 **ACP가 다자 프로토콜**이기 때문이다.
Claude Code에게 "내장 Write 쓰지 마"라고 시킬 수 없다.

**Octave는 그 처지가 아니다.**

- Octave는 사이드카의 **양 끝을 다 소유한다**
- `builtinTools`(`commands.rs:79`)로 모델에게 보이는 툴셋을 이미 제어한다
- 그리고 **이미 그렇게 하고 있다** — `src/agent/intake.ts:55`:
  ```ts
  builtinTools: ['Read', 'Glob', 'Grep'],
  ```
  `commands.rs:70-77` 주석이 이유를 명시:
  > "Ingest passes a read-only subset (typically `["Read", "Glob", "Grep"]`) so the model
  > cannot write to disk directly — proposals go through `submit_ingest_result` and the host
  > applies them after user review."

**즉 "호스트가 유일한 writer" 패턴은 이미 Octave 안에 있다. intake 경로에만 적용돼 있고 chat 경로에는 안 돼 있을 뿐이다.**

ACP가 포기한 것을 Octave는 강제할 수 있다. 감사 3-7(쓰기 주인 셋)의 해법은
**intake가 이미 하는 것을 chat으로 확장하는 것**이다. 새 설계가 아니다.

---

## 1. ACP 정확한 사실 (v1 stable 기준)

### 1.1 전송 · 프레이밍

| | LSP | **ACP** | **Octave** |
|---|---|---|---|
| 인코딩 | JSON-RPC 2.0 | JSON-RPC 2.0, UTF-8 필수 | JSON-RPC 2.0 |
| 프레이밍 | `Content-Length:` + `\r\n\r\n` | **개행 구분 JSON** (`\n`, 임베디드 개행 금지) | `Content-Length:` (LSP식) |
| 전송 | stdio | stdio가 유일 정의 전송 | stdio |
| 버전 협상 | 없음 (capability만) | 정수 `protocolVersion` (MAJOR) | 정수 1개, assert-equal |
| 취소 | `$/cancelRequest` | `$/cancel_request` (→ `-32800`) | 없음 |
| 종료 | `shutdown` + `exit` | 정의 없음 (클라가 stdin 닫음) | `shutdown` 알림 |

> Octave의 `Content-Length` 프레이밍은 ACP와 다르지만 **더 안전하다**(임베디드 개행 무관).
> 바꿀 이유 없음.

Streamable HTTP / WebSocket 전송은 **draft, in discussion** 상태다. 쓰지 말 것.

### 1.2 메서드 전량 (v1, `schema/v1/meta.json` 대조)

**클라이언트 → 에이전트**

| 메서드 | 종류 | 게이트 |
|---|---|---|
| `initialize` | request | baseline |
| `authenticate` | request | — |
| `logout` | request | `agentCapabilities.auth.logout` |
| `session/new` | request | **baseline** |
| `session/load` | request | `loadSession` |
| `session/resume` | request | `sessionCapabilities.resume` |
| `session/close` | request | `sessionCapabilities.close` |
| `session/list` | request | `sessionCapabilities.list` |
| `session/delete` | request | `sessionCapabilities.delete` |
| `session/set_mode` | request | `modes` 존재 시 |
| `session/set_config_option` | request | `configOptions` 존재 시 |
| **`session/prompt`** | **request → `stopReason`** | **baseline** |
| `session/cancel` | **notification** | baseline |

**에이전트 → 클라이언트**

| 메서드 | 종류 | 게이트 |
|---|---|---|
| **`session/update`** | **notification** | baseline |
| **`session/request_permission`** | **request** | baseline |
| `fs/read_text_file` | request | `clientCapabilities.fs.readTextFile` · **v2에서 삭제** |
| `fs/write_text_file` | request | `clientCapabilities.fs.writeTextFile` · **v2에서 삭제** |
| `terminal/create`·`output`·`wait_for_exit`·`kill`·`release` | request | `clientCapabilities.terminal` · **v2에서 삭제** |
| `elicitation/create` | request | `clientCapabilities.elicitation.form`/`.url` |
| `elicitation/complete` | notification | — |

**양방향**: `$/cancel_request` (notification, `requestId`). 수신자는 원 요청에
반드시 결과나 `-32800`으로 답해야 한다.

**에러 코드**: `-32700` parse, `-32600` invalid request, `-32601` method not found,
`-32602` invalid params, `-32603` internal, **`-32800` request cancelled**,
**`-32000` authentication required**, **`-32002` resource not found**.

**불안정 (쓰지 말 것)**: `providers/*`, `mcp/connect|message|disconnect`, `session/fork`,
`nes/*`, **`document/didOpen|didChange|didClose|didSave|didFocus`**.
마지막 것이 "에디터가 에이전트에게 미저장 버퍼 상태를 알림"인데 **v1·v2 모두 unstable**이다.

### 1.3 세션 다중화

- **에이전트 프로세스 하나가 N개 동시 세션을 서빙한다.**
  `get-started/architecture.mdx`: *"Each connection can support several concurrent sessions,
  so you can have multiple trains of thought going on at once."*
  단, 세션별 순서·공정성 보장은 스펙에 없고 상한도 없다
- **`sessionId`가 세션 스코프 메시지 전부에 필수 필드**다 — `session/prompt`, `session/cancel`,
  `session/update`(`SessionNotification`), `session/request_permission`, `fs/*` 양쪽, `terminal/*` 다섯 개 전부.
  `initialize`, `authenticate`, `logout`, `session/new`, `session/list`, `$/cancel_request`에는 없다
- **`SessionNotification` = `{sessionId, update}`** — `sessionId`가 params 레벨,
  `update`의 형제. update 안에 중첩돼 있지 않다
- **툴콜 상관키는 `(sessionId, toolCallId)`.** `terminalId`, `messageId`도 전부 세션 스코프
- **세션별 취소 프리미티브가 있다** — `session/cancel`(notification, `sessionId`만).
  해당 세션의 진행 중 프롬프트 턴만 취소한다
- **연쇄 취소**(`cancellation.mdx`): 클라가 `session/cancel` → 에이전트가 자기가 클라에게
  걸어둔 미결 요청들(`terminal/create`, `session/request_permission`)에 `$/cancel_request`를 팬아웃
  → 각각 `-32800` → 그제서야 원 `session/prompt`에 `stopReason: "cancelled"`로 답한다

### 1.4 스트리밍 — 알림 **하나**, 태그드 유니온

`{"method":"session/update","params":{"sessionId":…,"update":{"sessionUpdate":"<tag>", …평탄화}}}`

`allOf` 합성이라 **중첩 `data`/`payload` 래퍼가 없다.**

v1 안정 변형 11개 (`schema/v1/schema.json` `$defs.SessionUpdate.oneOf`):

| `sessionUpdate` | 페이로드 |
|---|---|
| `user_message_chunk` | 필수 `content: ContentBlock`; 옵션 `messageId` |
| `agent_message_chunk` | 필수 `content: ContentBlock`; 옵션 `messageId` |
| `agent_thought_chunk` | 필수 `content: ContentBlock`; 옵션 `messageId` |
| `tool_call` | 필수 `toolCallId`, `title`; 옵션 `kind`, `status`, `content[]`, `locations[]`, `rawInput`, `rawOutput` |
| `tool_call_update` | 필수 `toolCallId`; 나머지 전부 optional+nullable |
| `plan` | 필수 `entries: PlanEntry[]` |
| `available_commands_update` | 필수 `availableCommands[]` |
| `current_mode_update` | 필수 `currentModeId` |
| `config_option_update` | 필수 `configOptions[]` |
| `session_info_update` | 옵션 `title`, `updatedAt` |
| `usage_update` | 필수 `used`, `size`; 옵션 `cost: {amount, currency}` (ISO 4217) |

- **청크는 문자열이 아니라 `ContentBlock` 하나씩.** 변형: `text`, `image`, `audio`,
  `resource_link`, `resource` (MCP 타입 재사용)
- **`messageId`가 청크를 묶는다.** *"Chunks with the same `messageId` belong to the same message"*.
  v1 옵션, **v2 필수**
- **`agent_thought_chunk`가 사고 스트림의 일급 변형**이다 — 메시지와 분리
- **플랜은 전체 교체, 패치 아님.** *"The Agent **MUST** send a complete list of all plan entries
  in each update … The Client **MUST** replace the current plan completely."*
  엔트리 = `{content, priority: high|medium|low, status: pending|in_progress|completed}`
- **`user_message_chunk`가 존재하는 이유**: `session/load`가 히스토리를 `session/update`로 재생한다.
  *"The Agent **MUST** replay the entire conversation to the Client in the form of
  `session/update` notifications."*
- 툴 진행은 오직 반복 `tool_call_update`. 별도 진행 채널 없음

**`StopReason`**: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

### 1.5 권한

`session/request_permission` (에이전트 → 클라 request).
필수 3개: `sessionId`, `toolCall: ToolCallUpdate`, `options: PermissionOption[]`.

`PermissionOption = {optionId, name, kind}`.
**`PermissionOptionKind`**: `allow_once` / `allow_always` / `reject_once` / `reject_always`.
`kind`는 *"a hint to help Clients choose appropriate icons and UI treatment"*일 뿐 —
의미는 `optionId`에 있고 클라는 `optionId`를 되돌려준다.

**응답**: `{"outcome": {"outcome":"selected","optionId":"…"}}` 또는 `{"outcome":{"outcome":"cancelled"}}`.

**클라는 사용자 설정에 따라 자동 응답해도 된다** (*"Clients **MAY** automatically allow or reject
permission requests according to the user settings"*) — auto-accept 모드가 이렇게 정당화된다.

**취소 상호작용 — MUST 두 개**:
1. *"The Client **MUST** respond to all pending `session/request_permission` requests with the
   `cancelled` outcome."*
2. 클라는 `session/cancel`을 **보내는 즉시**, 에이전트를 기다리지 않고 해당 턴의 미완료 툴콜을
   전부 `cancelled`로 선표시해야 한다(SHOULD)

**주의**: 파킹된 권한 요청은 `{"outcome":"cancelled"}`라는 **정상 성공 응답**으로 풀린다.
`-32800` 에러가 아니다. (`-32800`은 에이전트가 별도로 `$/cancel_request`를 그 요청 id에 쏜 경우.)
**둘 다 합법이니 양쪽을 관용해야 한다.**

그리고 내재화할 경고(`prompt-turn.mdx`):
> "API client libraries and tools often throw an exception when their operation is aborted,
> which may propagate as an error response to `session/prompt`… Agents **MUST** catch these
> errors and return the semantically meaningful `cancelled` stop reason."

### 1.6 툴콜 모델

- **생성**: `sessionUpdate: "tool_call"`. 필수 `toolCallId`, `title`
- **갱신**: `sessionUpdate: "tool_call_update"`. **`toolCallId`만 필수, 나머지 전부 optional+nullable.**
  *"Only the fields being changed need to be included."*
  단 v1은 omitted vs `null` 패치 의미를 정의하지 않는다 — v2가 고치는 모호성
- **`ToolCallStatus`** (v1 4개): `pending`(*"input is either streaming or awaiting approval"*)
  → `in_progress` → `completed` | `failed`.
  **v1 스키마에 `cancelled` 상태가 없다** — 취소 산문은 "cancelled로 표시하라"고 하는데. 실제 갭이고 v2가 추가
- **`ToolKind`**: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
  **`switch_mode`**, `other`. (`switch_mode`는 스키마에 있고 `tool-calls.mdx` 목록엔 없다 — 문서 드리프트, 스키마를 믿을 것)
- **`locations`**: `{path(절대, 필수), line?(1-based)}[]`. 용도는 명시적으로 UX —
  *"enabling Clients to implement 'follow-along' features that track which files the Agent is
  accessing or modifying in real-time"*
- **`rawInput`/`rawOutput`**: 무타입 `object`. 디버그 뷰 및 특정 툴 네이티브 렌더용 탈출구

**`content`** — `type` 태그드 유니온 3개:
1. `{"type":"content","content": ContentBlock}`
2. **`{"type":"diff","path","oldText"?,"newText"}`** — `path`(절대)·`newText` 필수,
   `oldText` nullable(**`null` = 새 파일**). v1 diff 표현 전부다 —
   **패치가 아니라 전문 before/after.** diff 계산·렌더는 클라이언트가 한다
3. `{"type":"terminal","terminalId"}`

**v2는 diff를 완전히 다시 씀**: `oldText`/`newText` 삭제, `changes[]`(필수, `operation` ∈
`add|delete|modify|move|copy`) + `patch`(옵션, `git_patch` 포맷)로 교체.
*"There is no mechanical mapping from v2 diffs back to `oldText`/`newText`."*
또 v2는 `tool_call` 변형을 삭제하고 `tool_call_update` 하나가 **upsert**한다.

### 1.7 안정성 요약 — 오늘 기대도 되는 것

| 표면 | 상태 |
|---|---|
| stdio + 개행 구분 JSON-RPC, `initialize` 버전 협상 | **Stable v1** |
| `session/new`·`prompt`·`cancel`·`update`·`request_permission` | **Stable v1, baseline (모든 에이전트 MUST)** |
| `fs/*`, `terminal/*` | Stable v1, **optional — v2 draft에서 삭제** |
| `session/load`·`resume`·`close`·`list`·`delete`·`set_mode`·`set_config_option`, `elicitation/*`, `usage_update`, `messageId` | Stable v1, 각자 capability 뒤 |
| Streamable HTTP / WebSocket | **Draft, 논의 중** |
| 프로토콜 v2 전체 | **Draft.** `protocolVersion: 2` + Rust feature `unstable_protocol_v2`. 공지: *"Don't ship it by default in production."* |
| `document/did*`, `mcp/*`, `session/fork`, `nes/*` | **Unstable** |

### 1.8 기타 사실 정정

- 리포지토리가 **`agentclientprotocol/agent-client-protocol`**(벤더 중립 조직)으로 이전됐다.
  `zed-industries/…`는 리다이렉트. 저작권은 여전히 Zed Industries (Apache-2.0)
- 메인 리포에 **Rust/TS 레퍼런스 라이브러리가 더 이상 없다** — 스키마 크레이트와 문서만.
  SDK는 `agentclientprotocol/rust-sdk`, `typescript-sdk`, `python-sdk`, `java-sdk`, `kotlin-sdk`
- ACP는 LSP 모양을 하고 있지만 **LSP 타입이 아니라 MCP 타입을 재사용**한다
  (`architecture.mdx`: *"MCP-friendly … re-uses MCP types where possible"*)
- 키 네이밍: ACP 정의 키는 `camelCase`, 판별자 **값**은 `snake_case`

---

## 2. Octave와의 구조 차이

### 2-1. Octave의 JSON-RPC는 **단방향 반쪽**이다 ← 가장 중요

`client.rs:316-343`:
```rust
// JSON-RPC 2.0: presence of `id` distinguishes a response from a notification.
if let Some(id_value) = incoming.id.as_ref() {
    ...
    if let Some(tx) = pending.lock().await.remove(&id) { let _ = tx.send(outcome); }
    continue;                        // ← id가 있으면 무조건 "응답"
}
if let Some(method) = incoming.method { on_notification(method, params); }
```

**주석이 틀렸다.** JSON-RPC 2.0에서 `id`는 응답과 알림을 가르지 않는다.
**`id` + `method` = 요청**이다. 현 코드는 사이드카가 보낸 요청을
"없는 pending id에 대한 응답"으로 분류해 `remove(&id)` → `None` → **조용히 버린다.**

**즉 사이드카는 호스트에게 질문하고 답을 기다릴 수단이 없다.**

그래서 요청/응답을 **손으로 세 번 재구현**했다:

| 손으로 만든 것 | 알림 쌍 | 실패 모드 |
|---|---|---|
| `pendingDecisions` (`server.mjs:271`) | `chat/permission` → `chat/decision` | 스레드 닫히면 영구 pending (감사 3-10) |
| `pendingAcks` (`:278`) | `chat/edit-pending` → `chat/edit-ack` | 타임아웃 fail-open (`:1771`) |
| `pendingQueries` (`:283`) | `chat/query-notes` → `chat/query-result` | 5초 타임아웃 backstop (`:1784`) |

각각 id 발급, 맵 등록, 타임아웃, 취소 정리를 따로 쓴다.
**전송 계층이 공짜로 줬어야 할 것을 세 번 재발명했다.**

ACP에선 전부 그냥 요청이다:
`session/request_permission`, `fs/read_text_file`, `fs/write_text_file` — 셋 다 에이전트 → 클라 **request**.

> **수정 비용: `client.rs` 약 30줄.** `id`와 `method`가 **둘 다** 있으면 인바운드 요청으로 분류,
> 핸들러 결과를 응답으로 되돌린다. `pending` 맵과 `write_tx`는 이미 있다.
>
> **단, §3-5의 데드락 경고를 반드시 함께 적용할 것.**

### 2-2. 턴의 끝을 이벤트로 알리는 것 vs 요청이 resolve되는 것

| | Octave | ACP |
|---|---|---|
| 턴 시작 | `claude_chat_start` → 즉시 ack 반환 | `session/prompt` (request) |
| 턴 끝 | `claude:done` **또는** `claude:error`를 별도 리스너로 대기 | **같은 요청이 `stopReason`으로 resolve** |
| 종료 사유 | 영어 문자열 파싱 | `end_turn`/`max_tokens`/`max_turn_requests`/`refusal`/`cancelled` |
| 취소 | `chat/cancel` 알림 → 나중에 error 이벤트 | `session/cancel` → prompt가 `cancelled`로 resolve |

Octave가 **run 하나당 리스너 10개**를 거는 이유가 이것이다.
턴의 수명이 프로미스가 아니라 이벤트 구독의 집합이라,
시작·완료·에러·사이드카 사망을 전부 따로 걸고 `settled` 플래그로 수동 조정해야 한다
(`chat/index.ts:422`).

ACP 모델에선 `await prompt()` 한 줄이고 `stopReason`이 타입 있는 열거형이다.
감사 3-11(에러가 전부 String)이 여기서 같이 사라진다.

### 2-3. 채널 11개 vs 태그드 유니온 1개

Octave 아웃바운드:
```
chat/event  chat/done  chat/error  chat/task  chat/permission
chat/edit-pending  chat/skill-pending  chat/move-note
chat/set-status  chat/set-tags  chat/query-notes
```

이 중 6개는 **익명 인라인 제네릭으로 손으로 옮겨 적혀 있고 런타임 검증이 없다**
(`chat/index.ts:451, 781, 806, 832, 853, 874`).
`PROTOCOL.md`는 이 6개를 문서화조차 안 했다 — `manager.rs:411`의 기계적
`chat/<x>`→`claude:<x>` 규칙 덕에 **문서 없이도 그냥 동작해서** 아무도 안 고쳤다.

ACP는 `session/update` **하나**에 태그드 유니온. 채널이 하나라 스키마도 하나고,
새 변형은 유니온에 추가된다. **계약이 네 벌로 갈라질 자리가 없다.**

### 2-4. Octave가 재발명한 것들

| Octave | ACP 대응 | 차이 |
|---|---|---|
| `chat/edit-pending` + `edit-ack` + `pendingChangesStore` | `tool_call{kind:"edit", status}` + `content:[{type:"diff", path, oldText, newText}]` | ACP는 `pending→in_progress→completed/failed` 상태기계 + `tool_call_update`로 **부분 패치**. Octave는 매번 전체 재전송 |
| `PendingEdit`의 `before`/`after` **텍스트 앵커** | `diff`의 `oldText`(전문) / `newText` | 앵커는 사라질 수 있다 — `pendingChangesStore.ts:158` 주석이 "before 앵커가 없어져서 유저 텍스트가 이김"이라 기록. 전문 스냅샷은 항상 렌더·적용 가능 |
| `permissionMode` per-turn (`acceptEdits`는 선언만 되고 안 보냄, 감사 §4 #7) | `session/set_mode` + `current_mode_update` | ACP는 **에이전트가 스스로 모드를 바꾸고 알릴 수 있다**. plan → 승인 → code 전환이 프로토콜 개념 (`switch_mode` ToolKind까지 있음) |
| `contextUsage` 스파이크 | `usage_update{used, size, cost}` | 표준 업데이트 변형 |
| `chat/task` 백그라운드 레인 | `plan{entries[]}` (전체 교체) + 서브에이전트 트랜스크립트 | Zed는 "사이드바에 고정된 task list"로 렌더 |
| `PROTOCOL_VERSION` 정수 1개 (모양 바뀌어도 안 올림) | `initialize` + capability 협상 | 기능 단위. `fs.writeTextFile`이 false면 에이전트가 **호출 자체를 금지**당함 (`MUST NOT`) |

마지막 줄이 특히 중요하다. Octave는 `builtinTools: []`가 모든 툴을 허용하던 버그
(커밋 `727582f`)를 겪었는데, ACP는 **capability 미기재 = UNSUPPORTED**가 명시적 MUST다:
> *"Clients and Agents **MUST** treat all capabilities omitted in the `initialize` request as **UNSUPPORTED**."*

---

## 3. Zed 실제 구현에서 가져올 5가지

Zed는 Octave가 겪는 문제를 **전부 같은 자리에서 만났고**, 매번 *더 작은* 해법을 골랐다.
넷은 100줄 미만이다.

### 3-1. `StreamingTextBuffer` — 감사 2-1에 대한 직답

**Octave 현재** (`usePacedText.ts:55, 75-88`):
```ts
const offsets = useMemo(() => graphemeOffsets(content), [content])  // content 바뀔 때마다 전체 재계산
const tick = () => { setDisplayed(...); raf = requestAnimationFrame(tick) }  // 60fps
return content.slice(0, offsets[n])   // 매 프레임 전체 길이 문자열 신규 할당
```

**Zed** (`crates/acp_thread/src/acp_thread.rs:2121-2138, 2903-2988`) — 약 40줄:
```rust
struct StreamingTextBuffer {
    /// Text received from the model but not yet appended to the Markdown source.
    pending: String,
    /// The number of bytes to reveal per timer turn.
    bytes_to_reveal_per_tick: usize,
    target: Entity<Markdown>,
    _reveal_task: Task<()>,
}
impl StreamingTextBuffer {
    const TASK_UPDATE_MS: u64 = 16;   // ~1 frame
    const REVEAL_TARGET: f32 = 200.0; // 밀린 건 ~200ms 안에 다 뱉음
}
```
```rust
// 도착한 델타는 쌓이면서 tick 예산을 스스로 키움 — 밀리면 빨라진다 (:2911-2919)
buffer.pending.push_str(&text);
buffer.bytes_to_reveal_per_tick = (buffer.pending.len() as f32
    / StreamingTextBuffer::REVEAL_TARGET
    * StreamingTextBuffer::TASK_UPDATE_MS as f32).ceil() as usize;
```
```rust
// drain — UTF-8 경계 안전 (:2952-2988)
let byte_boundary = buffer.pending
    .ceil_char_boundary(buffer.bytes_to_reveal_per_tick)
    .min(buffer.pending.len());
markdown.append(&buffer.pending[..byte_boundary], cx);
buffer.pending.drain(..byte_boundary);
```

| | Octave | Zed |
|---|---|---|
| 구동 | `requestAnimationFrame` (프레임에 묶임) | 16ms **타이머** (프레임과 분리) |
| 예산 | 남은 양 / 상수 → 항상 60회/초 | **적응형** — 밀린 만큼 tick당 바이트를 키움 |
| 경계 | grapheme offset 배열을 매번 재계산 | `ceil_char_boundary` — 배열 없음 |
| 강제 배출 | 없음 | 새 엔트리·툴콜·턴종료·취소에서 `flush_streaming_text` (`:2717, 2799, 2996, 3787, 3881, 3905, 4022`) |

### 3-2. 단일 비행 파싱 래치 — 3줄이 순진한 전체 재파싱을 살린다 ← 가장 저렴한 승리

여기가 제일 놀랍다. **Zed도 마크다운을 증분 파싱하지 않는다.**

`crates/markdown/src/markdown.rs:744`:
```rust
pub fn append(&mut self, text: &str, cx: &mut Context<Self>) {
    self.source = SharedString::new(self.source.to_string() + text);
    self.parse(cx);   // pulldown-cmark 전체 재파싱
}
```
`crates/markdown/src/parser.rs`에 증분 진입점이 없다 —
`parse_markdown_with_options`는 `&str`을 받아 매번 새 `ParseState`를 만든다.

**살아남는 이유는 오직 이 래치다** (`markdown.rs:955-961`):
```rust
if self.pending_parse.is_some() {
    self.should_reparse = true;   // 이미 도는 중 → 예약만
    return;
}
self.should_reparse = false;
self.pending_parse = Some(self.start_background_parse(cx));  // cx.background_spawn (:973)
```
완료 시 (`:1080-1105`):
```rust
this.parsed_markdown = parsed;
this.pending_parse.take();
if this.should_reparse { this.parse(cx); }   // 밀린 건 딱 한 번만
cx.notify();
cx.refresh_windows();
```

**동시 파싱 최대 1개, 대기 최대 1개.**
느린 파싱 중 도착한 append N개가 재파싱 **1회**로 합쳐진다.
그리고 파싱이 느릴수록 빈도가 자동으로 낮아진다 — **스스로 튜닝되는 백프레셔**다.
debounce 타이머보다 싸고 견고하다.

**Octave엔 이게 통째로 없다.** 프레임마다 무조건 파싱한다.
래치는 상태 3개(`pending`, `shouldReparse`, 결과)면 된다.

### 3-3. 파일 쓰기 = "에이전트가 읽은 스냅샷 대비 diff" ← 감사 3-1 · 3-7의 정답

**Octave 현재**(`modelBodyBase.ts`): 모델에게 보여준 본문을 `baseBySlug`에 저장 →
`propose_write` 때 라이브 본문과 비교 → **다르면 전체 거부** → 모델에게 rebase 요청 →
최대 2회(`MAX_STALE_RETRIES`) → 포기하고 수동 검토.

**Zed** — 읽기는 디스크가 아니라 **열린 버퍼**에서, 그리고 본 것을 기록
(`acp_thread.rs:4207`):
```rust
let load = project.update(cx, |project, cx| {
    let path = project.project_path_for_absolute_path(&path, cx)
        .ok_or_else(|| acp::Error::resource_not_found(Some(path.display().to_string())))?;
    Ok::<_, acp::Error>(project.open_buffer(path, cx))     // 미저장 상태 포함
})?;
let buffer = load.await?;
action_log.update(cx, |action_log, cx| { action_log.buffer_read(buffer.clone(), cx); });
let snapshot = buffer.update(cx, |buffer, _| buffer.snapshot());
this.update(cx, |this, _| { this.shared_buffers.insert(buffer.clone(), snapshot.clone()); })?;
```

쓰기는 전문을 받아 **에이전트가 읽었던 스냅샷 대비 최소 diff로 변환**(`:4287`):
```rust
let snapshot = this.update(cx, |this, cx| {
    this.shared_buffers.get(&buffer).cloned().unwrap_or_else(|| buffer.read(cx).snapshot())
})?;
let edits = cx.background_executor().spawn(async move {     // 백그라운드에서 diff
    let old_text = snapshot.text();
    text_diff(old_text.as_str(), &content).into_iter()
        .map(|(range, replacement)| (snapshot.anchor_range_inside(range), replacement))
        .collect::<Vec<_>>()
}).await;

buffer.start_transaction();
buffer.edit(edits, None, cx);
buffer.end_transaction_with_source(BufferEditSource::Agent, cx);   // 에디터 undo 스택
action_log.update(cx, |action_log, cx| { action_log.buffer_edited(buffer.clone(), cx); });
project.update(cx, |project, cx| project.save_buffer(buffer, cx)).await
```

| | Octave CAS | Zed diff-against-snapshot |
|---|---|---|
| 유저가 **다른 곳** 편집 | **전체 거부** → 모델 rebase 요청 | **그냥 통과.** 앵커 범위가 겹치지 않음 |
| 유저가 **같은 곳** 편집 | 전체 거부 | 앵커가 그 범위만 처리 |
| 재시도 루프 | 필요 (최대 2회, 이후 포기) | **불필요** |
| 미저장 에디터 상태 | 모델이 못 봄 (SDK가 디스크 직접) | 항상 봄 (`open_buffer`) |
| undo | 별도 | 에디터 정상 undo, `BufferEditSource::Agent`로 출처 표시 |
| diff 계산 | 메인 스레드 | 백그라운드 executor |

**diff 리뷰**(`crates/acp_thread/src/diff.rs`): `Diff`는 `Pending` | `Finalized`,
둘 다 실제 `MultiBuffer` + `BufferDiff` 기반 — 리뷰 UI가 렌더된 패치가 아니라 **진짜 에디터**다.
`PendingDiff`는 버퍼를 observe해서 백그라운드에서 재계산한다.

### 3-4. 권한 대기 = 툴콜 상태 안의 `oneshot` ← 감사 3-10이 구조적으로 불가능해진다

**Octave**: `pendingDecisions` Map(`server.mjs:271`) + `rec.turnController.signal`에 abort 리스너.
그런데 `#teardownThread`는 `rec.controller`만 abort한다(`:1627`) →
**스레드를 닫으면 파킹된 게이트가 영원히 pending.**

**Zed** (`acp_thread.rs:3378`): 응답 채널을 **상태 열거형 안에** 넣는다.
```rust
let (tx, rx) = oneshot::channel();
let status = ToolCallStatus::WaitingForConfirmation {
    current_status, options, respond_tx: tx, kind,
};
self.upsert_tool_call_inner(tool_call, status, cx)?;
cx.emit(AcpThreadEvent::ToolAuthorizationRequested(tool_call_id.clone()));

Ok(cx.spawn(async move |this, cx| {
    let outcome = rx.await.unwrap_or(RequestPermissionOutcome::Cancelled);   // 없는 답 = 취소
    ...
}))
```
답할 때 (`:3428`) — `mem::replace`로 상태 전환과 응답이 **원자적으로 같은 사실**이 된다:
```rust
let curr_status = mem::replace(&mut call.status, new_status);
if let ToolCallStatus::WaitingForConfirmation { respond_tx, .. } = curr_status {
    respond_tx.send(RequestPermissionOutcome::Selected(outcome)).ok();
}
```

**별도 맵이 없으니 동기화가 어긋날 자리가 없다.**
"카드가 떠 있다"와 "응답을 기다린다"가 하나의 사실이다.

### 3-5. 핸들러는 일하지 않는다 — 큐에 넣고 즉시 반환 ← §2-1 구현 시 **필수** 주의

ACP SDK 문서가 명시하는 함정 (`agent-client-protocol-2.0.0/src/concepts/ordering.rs:9-21`):
> "Each connection has a central **dispatch loop** that processes incoming messages one at a
> time. … The key property: **the dispatch loop waits for each handler to complete before
> processing the next message.**"

그리고 데드락 (`:46-58`):
```rust
// DEADLOCK: This blocks the loop waiting for a response,
// but the response can't arrive because the loop is blocked!
builder.on_receive_request(async |request: MyRequest, responder, cx| {
    let response = cx.send_request(SomeRequest { … }).block_task().await?;
    responder.respond(response)
}, on_receive_request!());
```

**Zed의 모든 핸들러가 두 줄인 이유다** (`crates/agent_servers/src/acp.rs:294-378`):
```rust
/// Work items sent from `Send` handler closures to the `!Send` foreground thread.
trait ForegroundWorkItem: Send {
    fn run(self: Box<Self>, cx: &mut AsyncApp, ctx: &ClientContext);
    fn reject(self: Box<Self>);   // ← 큐가 닫혔을 때 hang 대신 에러 응답
}
type ForegroundWork = Box<dyn ForegroundWorkItem>;
```
```rust
macro_rules! on_notification {
    ($handler:ident) => {{
        let dispatch_tx = dispatch_tx.clone();
        async move |notif, _connection| { enqueue_notification(&dispatch_tx, notif, $handler); Ok(()) }
    }};
}
```
```rust
let (dispatch_tx, dispatch_rx) = mpsc::unbounded::<ForegroundWork>();
let dispatch_task = cx.spawn({ let mut dispatch_rx = dispatch_rx; async move |cx| {
    while let Some(work) = dispatch_rx.next().await { work.run(cx, &dispatch_context); }
}});
```
`enqueue_*`는 닫힌 큐를 `.reject()`로 처리해 `internal_error("ACP foreground dispatch queue
closed")`로 응답한다 — **미결 요청을 매달아 두지 않는다**(`:359-378`).

Zed 자신의 foreground 루프도 직렬이지만 `work.run()`이 **절대 await하지 않는다** —
request 핸들러는 `cx.spawn(...).detach()`, notification 핸들러는 완전 동기.
그래서 어느 세션도 다른 세션을 head-of-line block 하지 않는다.
`.block_task()`는 **오직 spawn된 태스크에서만** 부르고 핸들러 안에선 절대 안 부른다.

**Octave에 직접적으로 중요하다.** §2-1(양방향 요청)을 넣는 순간 이 함정이 생긴다.
`index.mjs:44`의 `server.handle(msg)`는 지금 fire-and-forget이라 안전하지만,
Rust `reader_loop`(`client.rs:341`)는 `on_notification`을 **읽기 루프 안에서 동기 호출**한다.
인바운드 요청 핸들러를 거기 붙이고 안에서 뭔가를 await하면 즉시 막힌다.

> **§2-1 구현 규칙**: 인바운드 요청은 큐에 넣고 즉시 반환 → 별도 태스크에서 처리 →
> 큐가 닫히면 `reject`로 에러 응답.

---

## 4. Zed 참고 — 프로세스 · 세션 · 백프레셔

### 4.1 프로세스 감독

`crates/agent_servers/src/acp.rs` `AcpConnection::stdio()` (~805).
런타임은 **`smol`**(tokio 아님). `util::process::Child`(`crates/util/src/process.rs:1-52`)가
`smol::process::Child`를 감싸며 **프로세스 그룹**을 만든다:
```rust
/// A wrapper around `smol::process::Child` that ensures all subprocesses are killed
/// when the process is terminated: on Unix by using process groups, and on Windows
/// by using job objects.
#[cfg(not(windows))]
pub fn kill(&mut self) -> Result<()> {
    let pid = self.process.id();
    unsafe { libc::killpg(pid as i32, libc::SIGKILL); }
    Ok(())
}
```
**Octave의 `hard_kill`(`client.rs:201`)과 완전히 같은 판단이다.**
Zed는 `impl Drop for AcpConnection`에서 부른다 — Octave는 `restart`에 안 붙어 있다(감사 3-5).

**프로세스는 (프로젝트 × 에이전트 종류)당 하나이고, 모든 세션이 공유한다.**
`AcpConnection`이 `sessions: Rc<RefCell<HashMap<acp::SessionId, AcpSession>>>`(`acp.rs:400`)를 쥔다.
`crates/agent_ui/src/agent_connection_store.rs`의 `Shared<Task<…>>`가
시작 중 동시 "스레드 열기" N건을 spawn 1회로 합친다.

**크래시 정책: 자동 재시작 없음, 백오프 없음.**
`agent_servers/src/`에 `restart|reconnect|backoff` 검색 결과 0건.
대신 종료를 *관측*해서 세션별 UI 에러로 바꾼다 — `LoadError::Exited { status, stderr }`가
**말미 stderr 블록**(`AcpDebugLog::trailing_stderr`, `acp.rs:220`)을 실어 유저에게 이유를 보여준다.
재시작은 유저 액션(`agent_connection_store.rs:118` `restart_connection`).
시작 레이스는 `futures::future::select(connection_rx, status_fut)`로 처리 —
핸드셰이크 전에 자식이 죽으면 행이 아니라 종료 에러가 난다.

**→ 이 항목은 Octave가 앞선다.** 감사 §5의 크래시루프 감독을 지킬 것.

### 4.2 세션 상태 소유

**권위 상태는 Rust, `Entity<AcpThread>` 안**(`acp_thread.rs:2084`):
```rust
pub struct AcpThread {
    session_id: acp::SessionId,
    parent_session_id: Option<acp::SessionId>,
    entries: Vec<AgentThreadEntry>,
    plan: Plan,
    project: Entity<Project>,
    action_log: Entity<ActionLog>,
    shared_buffers: HashMap<Entity<Buffer>, BufferSnapshot>,
    turn_id: u32,
    running_turn: Option<RunningTurn>,
    connection: Rc<dyn AgentConnection>,
    streaming_text_buffer: Option<StreamingTextBuffer>,
}
```
UI는 대화 상태를 갖지 않는다 — `EntryViewState`는 인덱스로 키잉된 *뷰* 객체(에디터·터미널·diff 뷰)만 캐시.
**Octave의 감사 3-8과 정반대다.**

모든 인바운드 메시지는 `session_id`로 라우팅되고, 모르는 id는 panic이 아니라 경고 후 드랍:
```rust
let Some(session) = sessions.get(&notification.session_id) else {
    log::warn!("Received session notification for unknown session: {:?}", notification.session_id);
    return;
};
```
> **패턴 주의**: `RefCell` borrow에서 필요한 것을 clone한 **뒤 borrow를 떨어뜨리고**
> `thread.update(cx, …)`를 부른다. 핸들러에서 `sessions`로 재진입하면 `RefCell` panic.

**훔칠 만한 것**: `AgentConnection`이 **trait**이고(`crates/acp_thread/src/connection.rs:91`),
Zed 자체 인프로세스 에이전트도 이걸 구현한다(`NativeAgentConnection`, `crates/agent/src/agent.rs:2074`).
서브프로세스 에이전트와 내장 에이전트가 **같은 `Entity<AcpThread>`를 낳으므로 UI 전체가 에이전트 무관**이다.

**취소는 양쪽**. 클라(`acp_thread.rs:3896`):
```rust
fn cancel_inner(&mut self, permission_outcome: RequestPermissionOutcome, cx: &mut Context<Self>) -> Task<()> {
    Self::flush_streaming_text(&mut self.streaming_text_buffer, cx);
    self.cancel_outstanding_elicitations(cx);
    let Some(turn) = self.running_turn.take() else { return Task::ready(()) };
    self.mark_pending_entries_as_canceled(permission_outcome, cx);
    self.connection.cancel(&self.session_id, cx);
    cx.emit(AcpThreadEvent::StatusChanged);
    cx.background_spawn(turn.send_task)
}
```
와이어(`acp.rs:2001`)는 알림 **전에** 플래그를 세워, 아직 열려 있는 `prompt` 요청으로 돌아오는
abort 에러를 재분류한다:
```rust
fn cancel(&self, session_id: &acp::SessionId, _cx: &mut App) {
    if let Some(session) = self.sessions.borrow_mut().get_mut(session_id) {
        session.suppress_abort_err = true;
    }
    self.connection.send_notification(acp::CancelNotification::new(session_id.clone())).log_err();
}
```
`prompt()`(`:1953-1994`)가 그 플래그를 읽어 "This operation was aborted"를
`Ok(StopReason::Cancelled)`로 바꾼다.

`RunningTurn { id: u32, send_task: Task<()> }`의 단조 `turn_id`가 후속 전송 레이스를 푼다 —
두 번째 전송이 턴1을 취소하고 턴2를 설치, 턴1 완료는 `is_same_turn`을 확인한 뒤 상태를 지운다
(`:3764-3775`). 회귀 테스트는 `:9463-9547`.

### 4.3 백프레셔

**채널은 전부 unbounded.** Zed의 `mpsc::unbounded::<ForegroundWork>()`,
SDK 트랜스포트 액터의 `unbounded_send(TransportFrame::Single(message))`,
`AcpSessionList`의 `async_channel::unbounded` + `try_send`.

**채널 레벨 백프레셔가 어디에도 없다.** 대신 **비용이 실제로 있는 두 곳**에 건다:
1. `StreamingTextBuffer` — 청크 도착률과 무관하게 `Markdown::append`를 블록당 ~62회/초로 유계화
2. `pending_parse`/`should_reparse` — 동시 파싱 1개 + 후행 재파싱 1개로 유계화

UI 갱신은 GPUI가 합친다 — `pending_notifications: FxHashSet<EntityId>`(`crates/gpui/src/app.rs:731`,
insert-guard `:2532`)라 한 엔티티에 대한 반복 `notify()`가 effect flush 안에서 재그리기 1회가 된다.

가상화는 `crates/agent_ui/src/conversation_view.rs:1267`:
```rust
let list_state = ListState::new(0, gpui::ListAlignment::Top, px(2048.0));
list_state.set_follow_mode(gpui::FollowMode::Tail);   // 스트리밍 중 하단 고정
```
스트리밍 갱신은 **행 하나만** 무효화(`:1614-1627`):
```rust
AcpThreadEvent::EntryUpdated(index) => {
    entry_view_state.update(cx, |view_state, cx| { view_state.sync_entry(*index, thread, window, cx); });
    list_state.remeasure_items(*index..*index + 1);
}
```

---

## 5. 베끼면 안 되는 것 — Zed의 알려진 약점

| Zed 코드 | 문제 | Octave는 |
|---|---|---|
| `markdown.rs:744` `self.source.to_string() + text` | 스트림 전체에 대해 **2차** 문자열 복사 | 로프나 in-place push로 |
| `markdown.rs:2121` `MarkdownElement::id() -> None` | 프레임 간 캐시 전무, 매 프레임 `TextRun`/`StyledText` 재생성 | 완료 블록 memo가 낫다 |
| `markdown.rs:3461` `language.highlight_text(&Rope::from(text), …)` | 코드블록 하이라이팅이 **메인 스레드 동기**, 보이는 블록마다 매 프레임 | 이미 CodeMirror가 있음 |
| 자동 재시작·백오프 없음 | crash → `LoadError` 띄우고 유저가 수동 재시작 | **Octave가 앞선다** |
| 채널 전부 unbounded | 느린 소비자 → 무제한 메모리 | 이미 `mpsc(64)` 유계 (지킬 것) |

**중요**: Zed는 가상화 리스트로 이 약점들을 버틴다.
**Octave엔 가상화가 없다**(`ChatPanel.tsx:816` 전량 마운트).
Zed의 마크다운 약점을 그대로 가져오면 Octave에선 더 나쁘다.

---

## 6. Octave가 이미 Zed보다 나은 것 (지킬 것)

- **크래시루프 감독** — 지수 백오프 + healthy-uptime 리셋 + 캡(`manager.rs:68`).
  Zed엔 `restart|reconnect|backoff` 검색 결과가 **0건**
- **프로토콜 버전 assert-equal**(`client.rs:234`) — 같은 번들이니 협상이 아니라 실패가 맞다
- **유계 stdin 채널** `mpsc::channel(64)`(`client.rs:149`) — Zed는 전부 unbounded
- **샌드박스 + deny rules** — Zed엔 대응물이 없다
- **프로세스 그룹 + killpg** — Zed와 **똑같은 판단**. `restart`에 배선만 하면 동등

---

## 7. ACP를 전면 채택해야 하나 — 아니오

**프로토콜로 갈아끼우는 건 권하지 않는다.**

- Octave의 도메인 툴 — `propose_edit` / `propose_write` / `propose_multi_edit` /
  `propose_skill` / `move_note` / `set_note_status` / `set_note_tags` / `query_notes` — 은
  ACP에 자리가 없다. v1 클라이언트 메서드는 `fs/*`, `terminal/*`, `elicitation/*`로 닫혀 있고
  **v2는 앞의 둘도 삭제**한다
- v2가 draft이고 공지가 *"Don't ship it by default in production"*이라 지금 타겟이 불명확하다
- 이득은 상호운용성인데, Octave는 자체 사이드카를 계속 쓸 것이므로 그 이득을 받지 못한다

**대신 설계 결정만 가져온다.** 아래 §8이 그 목록이다.

---

## 8. 통합 실행 순서

`docs/rust-architecture-audit-2026-07.md` §6의 순서에 본 문서 항목을 끼워 넣은 최종본.
**0~4는 오늘 안에 끝난다.**

| # | 할 일 | 출처 | 고치는 것 | 크기 |
|---|---|---|---|---|
| **0** | `credential_helper_args` 잔해 삭제 | — | Rust 테스트 20개 부활 | 분 |
| **1** | 토큰·키 `OnceLock` 캐시 | — | 감사 2-4: 시작마다 `ioreg` 10ms 직렬화 | ~30줄 |
| **2** | `restart`에서 스왑 전 `old.hard_kill()` | **Zed §4.1** | 감사 3-5: CLI 손자 누수 | 극소 |
| **3** | 릴레이 getter에 `?? bgTurnRunId` | — | 감사 3-4: 백그라운드 제안 무음 폐기 | 극소 |
| **4** | `modelBodyBase`를 runId로 키잉 | — | 감사 3-1: 무음 유실 (11의 임시 봉합) | 소 |
| **5** | **단일 비행 파싱 래치** | **Zed §3-2** | **감사 2-1: 프레임마다 전체 재파싱** | **~3줄 상태** |
| **6** | `usePacedText`를 타이머 + 적응형 예산으로 | **Zed §3-1** | 감사 2-1: rAF 60fps + grapheme 전체 재계산 | ~40줄 |
| **7** | `client.rs`: `id`+`method` = 인바운드 요청. **핸들러는 큐잉만** | **ACP §2-1 + Zed §3-5** | correlation map 3개, 게이트 누수, fail-open 타임아웃 | ~30줄 |
| **8** | 권한 대기를 툴콜 상태 안의 채널로 | **Zed §3-4** | 감사 3-10: 파킹 게이트 누수 구조적 제거 | 소 |
| **9** | `chat/event`를 run별 `ipc::Channel`로 + `&RawValue` 통과 | — | 감사 2-2: `창×run` 증폭, zod-후-폐기 | 중 |
| **10** | 서브에이전트 `stream_event` 드랍 (`server.mjs:1145`) | — | 감사 2-3 | 극소 |
| **11** | 턴 = resolve되는 요청 + 타입 `stopReason` | **ACP §2-2** | 감사 2-2·3-11: run당 리스너 10개, String 에러 | 중 |
| **12** | 채팅 리스트 가상화 | **Zed §4.3** | 감사 2-8 | 중 |
| **13** | **쓰기를 "읽은 스냅샷 대비 diff"로. chat도 `builtinTools`에서 Write/Edit 제거** | **Zed §3-3 + §0.3** | **감사 3-1·3-7: 쓰기 주인 셋 = 저장유실 뿌리, CAS 재시도 루프 제거** | 대 |
| **14** | 채널 11개 → 세션 스코프 태그드 유니온 1개 | **ACP §2-3** | 감사 §4: 계약 4벌 드리프트 | 중 |

**5·6·9가 "빠르게"의 대부분** (5·6은 합쳐 ~50줄),
**7이 8·11·13의 전제**,
**13이 "에러가 전혀 없어야"의 핵심**이다.

권장 진입점: **5번**(오늘 체감이 바뀜) 또는 **7번**(이후 절반의 전제).

---

## 부록 — 참고 링크

- ACP 스펙: https://agentclientprotocol.com
- ACP 리포(벤더 중립): https://github.com/agentclientprotocol/agent-client-protocol
- Rust SDK: https://github.com/agentclientprotocol/rust-sdk
- Zed: https://github.com/zed-industries/zed
  (`crates/agent_servers`, `crates/acp_thread`, `crates/agent_ui`, `crates/markdown`)
- `claude-agent-acp` (Claude Agent SDK ↔ ACP 어댑터 — Octave 사이드카와 같은 일을 표준으로):
  https://github.com/agentclientprotocol/claude-agent-acp
- Zed 블로그 — Claude Code via ACP: https://zed.dev/blog/claude-code-via-acp
