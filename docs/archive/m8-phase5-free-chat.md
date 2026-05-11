# M8 Phase 5 — 자유 채팅 (Free Chat)

작성: 2026-05-02
상태: **Draft** — 구현하면서 다듬을 것

---

## 목표

지금 ChatPanel은 `[Run Review]` 버튼만. 여기에 **자유 텍스트 입력 + AI 응답**을 추가해 노트앱에 결합된 진짜 코파일럿으로 만든다.

핵심 인터랙션: **본문 selection → Cmd+L → 채팅 입력창에 selection chip + 자유 질문**. AI는 답변 텍스트 + (필요 시) 본문 인라인 마크 제안을 자발적으로 생성. 대화는 문서별·thread별로 영속화.

---

## 결정 사항 (확정)

| 항목 | 결정 |
|---|---|
| 입력 인터랙션 | **selection + Cmd+L** 흐름 (Cursor 패턴) + 일반 자유 입력 |
| AI 답변에서 propose_change | **자발적 생성 허용** — 모델이 필요하다 판단하면 인라인 마크 제안 |
| 대화 영속화 | **Y.Doc 안에 저장** — Hocuspocus가 sync, multi-device 공짜 |
| 영속화 단위 | **문서당 N개 thread** (multi-thread from day 1) |
| Switcher 형태 | **가로 탭** — 최대 5개 active, `[+]` 5개 다 차면 disabled + 툴팁 |
| 탭 [×] hover | **soft archive** (영구 삭제 X, archived=true 플래그) |
| 시계 아이콘 | **archive popover** — 버튼 아래로 dropdown처럼 떠서 archived thread 목록 + ↻ restore |
| 영구 삭제 | Phase 5엔 없음 (soft delete만) |
| 자동 제목 | **Haiku 비동기 호출** — 입력 언어 자동, 실패 시 첫 메시지 30자 fallback |
| 탭 더블클릭 | 인라인 제목 편집 |
| Streaming | **포함** — Tauri SSE forwarding |
| SDK 전략 | **`@anthropic-ai/sdk` + custom fetch via Tauri proxy` (패턴 C) |

---

## 아키텍처

### 네트워크·인증 — 패턴 C

```
[Frontend]                      [Tauri Rust]               [Anthropic]
                                     │
new Anthropic({                      │
  fetch: tauriFetch                  │
}).messages.stream({...})            │
        │                            │
        └─tauriFetch(url, init)──▶ claude_proxy
                                     │  토큰 헤더 주입
                                     │  ────────────HTTP────▶
                                     │  ◀────SSE stream──────
        ◀─event 'claude:chunk'──────│  (chunk byte 그대로 forward)
```

**이유**:
- 브라우저(Tauri webview)는 CORS로 `api.anthropic.com` 직접 호출 불가
- OAuth 토큰은 Rust keychain에만 둠 (frontend 노출 금지)
- SDK가 주는 SSE 파싱 / tool input partial JSON 누적 / 타입 / retry 다 가져감

**Rust side 변경**:
- 기존 `claude_messages_create` 명령 → 일반화한 `claude_proxy(url, init, channelId)` 추가
- 토큰을 `Authorization: Bearer ...` 헤더에 주입
- response body를 stream으로 읽어 `app.emit("claude:chunk:<channelId>", bytes)` 로 frontend 흘림
- 종료 시 `claude:done:<channelId>` 또는 `claude:error:<channelId>`

**Frontend side**:
- `lib/tauriFetch.ts` — `fetch` 시그니처 호환 함수. 내부에서 channelId 발급하고 Tauri command 호출 + event listener로 ReadableStream 구성. SDK는 그걸 일반 fetch처럼 씀.
- `lib/anthropic.ts` — `new Anthropic({ apiKey: 'unused', fetch: tauriFetch, baseURL: 'https://api.anthropic.com' })` 한 곳에서 인스턴스 export.

### 영속화 모델 — Y.Doc 안의 multi-thread

```
Y.Doc(slug)
  ├── content                    (ProseMirror — 기존)
  ├── marks                      (Y.Map<id, StoredMark> — 기존)
  ├── threads                    (Y.Array<ThreadMeta>)        ← NEW
  └── thread:<id>                (Y.Array<ChatTurn>)          ← NEW (thread별)
```

```ts
type ThreadMeta = {
  id: string                     // crypto.randomUUID()
  title: string                  // Haiku 자동 생성, 실패 시 첫 메시지 30자 fallback
  createdAt: number
  updatedAt: number
  archived: boolean              // soft delete — false=active 탭, true=archive popover
  archivedAt?: number            // popover 정렬용 (최신순)
}

type ChatTurn = {
  id: string
  role: 'user' | 'assistant'
  content: string                // markdown
  ts: number
  attachments?: Attachment[]     // selection chip 등
  toolCalls?: ToolCall[]         // propose_change 등 호출 기록
  citations?: Citation[]         // 본문 인용 (Phase 5.1+)
  status?: 'streaming' | 'done' | 'error'
}

type Attachment =
  | { type: 'selection'; from: number; to: number; preview: string }
  // 첨부 파일은 Phase 5.1+

type ToolCall = {
  id: string                     // tool_use_id
  name: string                   // 'propose_change' 등
  input: unknown
  result?: { ok: true; markId: string } | { ok: false; reason: string }
}
```

**활성 thread 추적**:
- `localStorage` 에 `activeThreadId:<docSlug>` 저장
- Y.Doc에 안 넣는 이유: 디바이스 간 sync되면 어색함 (각 디바이스가 다른 대화를 보고 있을 수 있음)

### 컴포넌트 구조

```
src/
  layout/
    ChatPanel.tsx                  # 얇게 — switcher + ThreadView
  
  chat/
    ThreadSwitcher.tsx             # dropdown: thread 목록 + [+ New chat]
    ThreadView.tsx                 # 메시지 리스트 + 입력창 (특정 thread)
    MessageList.tsx                # turns 렌더링
    MessageRow.tsx                 # 개별 turn (role별 스타일 + tool chip)
    PromptInput.tsx                # 입력창 (textarea + chips + 전송)
    SelectionChip.tsx              # selection 첨부 표시
    ToolCallChip.tsx               # 진행 중 / 완료 도구 호출 표시
  
  hooks/
    useThreads.ts                  # ydoc.getArray('threads') 구독, CRUD
    useThreadTurns.ts              # ydoc.getArray('thread:<id>') 구독
    useActiveThread.ts             # localStorage 기반 활성 thread
    useClaudeStream.ts             # SDK 스트림 → React state, abort
    useSelectionAttach.ts          # Cmd+L 전역 핸들러 + selection 추출
  
  agent/
    chat.ts                        # 자유 채팅 entry — system prompt + tool loop
    runReview.ts                   # 기존 — 그대로 유지
    skills/
      copyeditor.ts                # 기존
      freechat.ts                  # NEW — 자유 채팅용 system prompt
    tools.ts                       # propose_change (기존) + 향후 read_section 등
  
  lib/
    tauriFetch.ts                  # SDK용 fetch 구현 (Tauri channel wrapping)
    anthropic.ts                   # Anthropic SDK 인스턴스 + factory
  
  src-tauri/src/
    claude_api.rs                  # claude_proxy command (스트리밍)
```

---

## 상세 설계

### 1. 자유 채팅 entry (`agent/chat.ts`)

```ts
export async function runChat(opts: {
  view: EditorView
  ydoc: Y.Doc
  threadId: string
  userMessage: string
  attachments: Attachment[]
  history: ChatTurn[]            // 직전까지의 thread turns
  signal: AbortSignal
  onEvent: (e: StreamEvent) => void
}): Promise<void>
```

흐름:

1. **Context 빌드**
   - System prompt = `FREECHAT_PROMPT` + `<document>` 본문 (cache_control: ephemeral)
   - History를 SDK messages 포맷으로 변환
   - 이번 user 메시지에 selection attachment 있으면 본문 텍스트에 `<selection from=X to=Y>...</selection>` 태그로 포함

2. **SDK 호출 (streaming + tool loop)**
   ```ts
   const stream = anthropic.messages.stream({
     model: 'claude-haiku-4-5-20251001',
     max_tokens: 4096,
     system: [{ type: 'text', text: ..., cache_control: { type: 'ephemeral' } }],
     tools: [proposeChangeTool],         // 옵셔널 — 모델이 필요할 때만 호출
     messages: [...history, { role: 'user', content: ... }],
   })
   ```

3. **이벤트 처리** — SDK가 던지는 event를 onEvent로 forwarding
   - `text` delta → `{ kind: 'text_delta', text }`
   - `tool_use` start → `{ kind: 'tool_start', id, name }`
   - `input_json_delta` → `{ kind: 'tool_input_delta', id, partial }`
   - `tool_use` complete → `{ kind: 'tool_complete', id, input }` + 즉시 도구 실행
     - `propose_change` 의 경우 `applyProposal(view, ydoc, input)` 호출 → markId 받음
     - 결과를 `tool_result`로 다음 turn에 첨부
   - `message_stop` → 모델이 더 도구 안 부르면 종료, 부르면 loop 계속
   - 모든 이벤트 `signal.aborted` 시 stream cancel

4. **저장**
   - 매 텍스트 delta마다 turn의 content 업데이트 (Y.Array의 해당 항목 replace) — Yjs CRDT라 sync 자연스러움
   - tool 호출은 toolCalls 배열에 push

### 2. Cmd+L 흐름

`useSelectionAttach`:

```ts
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey && e.key === 'l') {
      e.preventDefault()
      const sel = view.state.selection
      if (!sel.empty) {
        const text = view.state.doc.textBetween(sel.from, sel.to)
        chatStore.attachSelection({ from: sel.from, to: sel.to, preview: text })
      }
      chatStore.focusInput()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [view])
```

PromptInput에 chip으로 표시 — `[× selection: "yesturday I we..."]` 형태. 사용자가 X 누르면 떼어냄. 전송 시 attachment 배열에 포함.

### 3. Streaming UI

`useClaudeStream` 가 반환:
```ts
{
  status: 'idle' | 'streaming' | 'error',
  start(opts): void,        // runChat 호출
  abort(): void,            // AbortController.abort()
}
```

ThreadView는 turns를 그대로 렌더. streaming 중인 마지막 assistant turn은 `status: 'streaming'` 이라 cursor blink + Stop 버튼 표시.

Stop 누르면 `abort()` → SDK stream cancel → Tauri proxy의 reqwest stream drop → 부분 응답까지는 저장.

### 4. Tool loop with self-cancel

도구 호출 중 사용자가 Stop 누르면:
- 진행 중 tool이 propose_change면 이미 commit된 마크는 keep, in-flight는 abort
- Y.Doc은 CRDT라 partial state가 의미 있게 남음

### 5. system prompt — `skills/freechat.ts`

대략:

```
You are a writing copilot embedded in a markdown note app. The user is
working on a single document, shown below in <document>.

You can:
1. Answer questions about the document or general writing.
2. Propose targeted edits using the `propose_change` tool when the user
   asks for them, or when you spot a clear issue. Don't propose edits
   unsolicited unless the user is asking for review/feedback.
3. Reference specific passages by quoting them.

If the user has attached a selection, focus on it but use surrounding
context for tone awareness.

<document>
{doc text, capped at 60K chars}
</document>
```

cache_control 붙여서 같은 문서 연속 질의 시 토큰 90% 절감.

### 6. 사용자 메시지 → thread title 자동 생성

새 thread의 첫 user message 보낼 때:
- title이 비어 있으면 message 앞 30자로 set
- ThreadMeta.updatedAt 갱신

---

## 구현 순서 (작업 단위)

총 추정 5~7h.

### Step 1 — Tauri proxy + SDK wiring (1.5h) ✅ 완료
- [x] `src-tauri/src/claude_api.rs` — `claude_proxy` + `claude_cancel`, streaming forward
- [x] `lib/tauriFetch.ts` — Tauri event를 ReadableStream으로 wrap
- [x] `lib/anthropic.ts` — SDK singleton
- [x] `runReview.ts` → SDK API 마이그레이션 + 검증

### Step 2 — Thread 데이터 모델 + tab switcher + archive (1.5h) ✅ 완료
- [x] `hooks/useThreads.ts` — Y.Array 구독 + create/archive/restore/rename
- [x] `hooks/useThreadTurns.ts` — thread별 turn array 구독 + append/update
- [x] `hooks/useActiveThread.ts` — localStorage 기반 활성 thread id
- [x] `agent/generateThreadTitle.ts` — Haiku 비동기 호출
- [x] `chat/ThreadTabs.tsx` — 가로 탭 (Radix Tabs primitive)
- [x] `chat/ArchivedThreadsPopover.tsx` — popover, archived 목록 + ↻ restore
- [x] 빈 문서 첫 진입 시 자동 thread 1개 생성
- [x] `ChatPanel.tsx` 통합 — useThreadTurns 사용

### Step 3 — PromptInput + 자유 입력 (1h) ✅ 완료
- [x] `chat/PromptInput.tsx` (textarea + Cmd+Enter 전송 + Stop)
- [x] Tabler 아이콘 교체

### Step 4 — Streaming + chat entry (1.5h) ✅ 완료
- [x] `agent/chat.ts` — runChat 함수 + tool loop, `includePartialMessages` 활성
- [x] `agent/skills/freeChat.ts`
- [x] 토큰별 streaming + Y.Array sync 안정화 (Streamdown)
- [x] MessagePart (text/reasoning/tool) 모델로 통합 렌더

### Step 5 — Selection + Cmd+L ✅ 완료
- [x] frozenSelectionPlugin 으로 selection 캡처
- [x] selection chip + send-button hint
- [x] pre-submit slash validation

### Step 6 — Tool 호출 시각화 ✅ 완료
- [x] propose_change tool part special-casing (Tool/ToolHeader/ToolContent)
- [x] applyProposal → 인라인 마크 생성 + tool_result 회신
- [x] /review (review-comments kind) — Run Review 버튼 제거, slash로 통합
- [x] /polish, /shorten, /expand (document-edit kind)
- [x] /outline (chat-message kind)

### Step 7 — Reliability + edge cases (30m) 🟡 진행 중
- [x] Stop 중간 abort
- [x] OAuth 흐름 (PKCE + Rust keychain)
- [ ] 네트워크 실패 / rate limit 에러 메시지 분기 — 미세 조정 필요
- [ ] 매우 긴 문서 truncation 경고
- [ ] 빈 user 메시지 / 연속 전송 방지

---

## Phase 5에 포함 안 함 (Phase 5.1+)

- `@-mention` (selection 외 outline / mark / file 첨부)
- 슬래시 커맨드 (`/edit`, `/summarize`, `/translate`)
- 추가 도구 (read_section, get_outline)
- 첨부 파일 (이미지 / PDF) — chatService.ts:46-80 패턴 차용 가능
- Selection-scoped ghost text rewrite preview
- Citations 클릭 → 본문 jumpToMark
- Extended thinking blocks
- Multi-thread 검색

---

## Reliability 체크리스트 (CLAUDE.md 원칙)

- [ ] OAuth 토큰 만료 → 자동 재인증 트리거 (기존 흐름 재사용)
- [ ] 네트워크 끊김 mid-stream → 부분 응답 보존 + 사용자에게 명확한 에러
- [ ] AbortError 와 진짜 에러 구분
- [ ] Yjs 동시 편집 race — turn 추가 / 갱신은 transaction 안에서
- [ ] 같은 thread 동시 두 메시지 전송 방지 (running 상태 체크)
- [ ] 매우 긴 문서 (60K cap) — 사용자에게 잘림 알림
- [ ] Empty doc + Run Review 호출 (기존 처리 유지)
- [ ] 토큰 비용 / 사용량 추후 표시 가능하게 usage 데이터 보존

---

## 검증 시나리오

1. **새 문서 열기** → 자동 thread 1개 생성됨, 입력창 보임
2. **자유 입력** "이 글 톤 어때?" → AI 답변 streaming, 인라인 마크 안 생김
3. **selection + Cmd+L** → chip 붙고 입력 포커스 → "더 짧게 줄여줘" → AI가 propose_change 호출 → 본문에 마크 생김 → popover로 accept 가능
4. **Stop** → mid-stream 중단, 부분 답변까지 thread에 저장
5. **새로고침** → thread 목록 + 모든 turn 그대로 복원
6. **+ New chat** → 빈 thread 추가, 이전 thread는 dropdown에서 접근
7. **다른 문서로 이동** → 그 문서의 thread만 보임
8. **다시 원래 문서** → 그 문서 thread / 활성 thread 복원
9. **OAuth disconnect** 상태 → 입력창 disabled, 안내 오버레이
10. **rate limit** → 명확한 에러 메시지 + 재시도 버튼

---

## 미결 (구현 중 결정)

- 활성 thread 표시 위치: 채팅 패널 상단 dropdown vs 별도 sidebar
- New chat 단축키 (`Cmd+Shift+L`?) — 일단 버튼만, 단축키는 추후
- Thread 삭제 UX — 일단 dropdown 메뉴에 묻어두고, 확인 다이얼로그 후 삭제
- Tool 호출 chip 디자인 — 텍스트 본문에 inline vs 메시지 하단 별도 영역
- system prompt 톤 — 한국어/영어 mix 어떻게 할지 (사용자 입력 언어 따라가기로 시작)
