# Prompt Input LLM 통제 surface 확장 설계

> 채팅 prompt input에서 사용자가 조절하는 LLM 통제 변수를 넓힌다.
> 현재: **model + effort(reasoning)** 2개.
> 추가 대상: **(1) Fast mode, (2) Plan mode, (3) Context 게이지 + auto compaction.**

작성 기준: Claude Agent SDK `@anthropic-ai/claude-agent-sdk@0.2.121` (사이드카 설치 버전).

---

## 0. 현재 구조 요약

채팅 한 turn의 통제 변수 흐름:

```
PromptInput (model/effort 토글)
  → ChatPanel → useChatRunner → runChat(RunChatArgs)
  → agent/chat/index.ts : invoke('claude_chat_start', args)
  → Rust commands.rs ChatStartArgs (passthrough → JSON params)
  → 사이드카 server.mjs #runChat : query({ prompt, options })  ← Agent SDK
  ← chat/event / chat/done / chat/error 알림
  ← manager.rs : 알림 params를 통째로 claude:* Tauri 이벤트로 emit
```

별도 경로: `anthropicDirect.ts` → Rust `anthropic.rs`(`anthropic_messages_create`) = 직접 Messages API.
강제 tool 스키마용(title/profile/ingest). 채팅 본류는 위 Agent SDK 경로.

현재 사이드카에 넘어가는 통제 변수: `model`, `effort`, `systemPrompt`, `relayTools`,
`builtinTools`, `permissionMode`, `maxTurns`, `sessionId/resume`, `vaultPath`.

---

## 1. Fast mode

### 개념
같은 Opus 모델을 더 빠른 추론 경로로 실행. **출력 토큰 속도(OTPS) 최대 2.5배**, 모델 지능·동작 동일,
가격 프리미엄. **Opus 4.6/4.7/4.8 전용**(Sonnet·Haiku 불가). 생각 속도(TTFT)는 그대로, 답을 써내려가는 속도만 빨라짐.

### 동작원리 (Messages API 레벨)
- 직접 API: `speed: "fast"` + 베타 헤더 `anthropic-beta: fast-mode-2026-02-01`.
- 응답 `usage.speed`(`"fast"`|`"standard"`)로 실제 적용 확인.
- 전용 rate limit(초과 시 429 + `retry-after`). fast/standard 간 prompt cache 미공유.
- Anthropic 계정에 research preview 액세스 필요(account manager / waitlist).

### 동작원리 (Agent SDK 레벨) — **확인됨**
SDK가 fast mode를 1급으로 지원한다. `sdk.d.ts`(0.2.121):
- `interface Settings`(L3734) 안에 `fastMode?: boolean`(L4896), `fastModePerSessionOptIn?: boolean`(L4900).
- 모델 정보에 `supportsFastMode?: boolean`(L1092).
- 메시지에 `fast_mode_state?: 'off' | 'cooldown' | 'on'`(L2603 등) 반환 → 실제 적용 검증 가능.
- `Options.betas?: SdkBeta[]`(L1285)도 있음.

핵심: **`settings.fastMode`는 사이드카가 이미 쓰는 `settings: { autoCompactEnabled: true }`와 같은 `Settings` 객체.**
베타 헤더 수작업 불필요 — `settings`에 `fastMode: true` 한 줄 추가하면 SDK가 처리.

---

## 2. Plan mode

### 개념
Claude가 **읽기·분석·계획만 하고 어떤 변경도 실행하지 않는** 읽기 전용 모드.

### 동작원리
`Options.permissionMode`. 값:

| 값 | 의미 |
|---|---|
| `default` | 표준 권한 (canUseTool 콜백 협의) |
| `acceptEdits` | 파일 편집 자동 수락 |
| `bypassPermissions` | 권한 검사 전부 무시 (현재 채팅 기본값) |
| **`plan`** | **읽기 전용 도구만, 실행 차단** |
| `dontAsk` | 사전 승인 안 된 건 묻지 않고 거부 |
| `auto` | 모델 분류기가 도구별 승인/거부 |

세션 중 동적 전환 가능. plan 모드에서 `AskUserQuestion`으로 요구사항 되묻기 가능.

### 이 앱의 특수성
"쓰기"가 built-in Edit/Write가 아니라 `propose_*` MCP relay tool이다.
`permissionMode: 'plan'`이 MCP 쓰기 도구까지 막는지는 1회 검증 필요.
검증과 무관하게 **앱 레벨에서 relayTools를 read-only로 스코프**하면 결정적으로 안전(SDK 동작에 비의존).
→ 두 장치를 함께 적용(plan mode + relay 스코프 축소)한다.

---

## 3. Context 게이지 + auto compaction

### 개념
- **게이지**: 이번 세션이 모델 context window를 얼마나 채웠는지 %로 표시.
- **auto compaction**: 한계 근처에서 이전 대화 히스토리를 요약 압축해 한계를 넘어 계속 진행.

※ 주의: 이미 받고 있는 `rate_limit_info.utilization`(5시간/7일 사용량 축)과 **다른 축**.
context 게이지는 "이 대화의 토큰이 모델 한계에 얼마나 가까운가".

### 동작원리 — **데이터·압축 모두 이미 흐름**
- 사이드카 `chat/done`이 매 turn `usage` + `total_cost_usd` 방출(`server.mjs:853-860`).
- `manager.rs:232`가 알림 params를 통째로 `claude:done`으로 emit → **usage·cost가 이미 프론트 도달**.
- `settings.autoCompactEnabled: true`(`server.mjs:608`) → **auto-compaction 이미 ON**.
- 압축 시 `SDKCompactBoundaryMessage`(`type:'system'`, `subtype:'compact_boundary'`,
  `compact_metadata:{ trigger, pre_tokens, post_tokens? }`)가 `chat/event`로 흐름 → 현재 streamParser가 드롭.

게이지 값 = 직전 turn의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
÷ 모델 context limit(기본 200k).

---

## 4. 핵심 발견 — 이미 깔려 있는 인프라

| 필요 요소 | 상태 | 위치 |
|---|---|---|
| `permissionMode` Rust passthrough | ✅ 있음 | `commands.rs:41,128-130` |
| `permissionMode` 사이드카 forward | ✅ 있음 | `server.mjs:587,596` |
| `maxTurns` 전 경로 | ✅ 있음 | `commands.rs:65` / `server.mjs:637` |
| auto compaction | ✅ ON | `server.mjs:608` |
| `usage`+`cost` done 방출 | ✅ 있음 | `server.mjs:853-860` |
| done payload 프론트 전달 | ✅ 통째 forward | `manager.rs:232` |
| `fastMode` SDK 지원 | ✅ Settings 필드 | `sdk.d.ts:4896` |
| `permissionMode` 프론트→invoke 전달 | ❌ 누락 | `agent/chat/index.ts:312` invoke args |
| `DoneEvent`가 usage 읽기 | ❌ 미선언 | `agent/chat/types.ts` `DoneEvent` |
| streamParser compact_boundary 처리 | ❌ 드롭 | `streamParser.ts:253` |
| `speed/fastMode` Rust·사이드카·프론트 | ❌ 없음 | 신규 |

**결론**: 세 기능 모두 처음 추정보다 변경량이 작다. 특히 게이지는 데이터가 이미 끝까지 와 있고,
plan mode는 백엔드 배선이 끝나 있다.

---

## 5. 구현 계획

### 공통 패턴 (per-thread 설정 추가)
`ThreadMeta` 필드 추가 → `PromptInput` 토글 → `ChatPanel`이 `RunChatArgs`로 전달
→ `agent/chat/index.ts`가 invoke args에 추가 → Rust `ChatStartArgs` passthrough → 사이드카 `options`.
(model/effort이 이미 이 경로를 탄다 — 동일 패턴 복제.)

---

### 기능 A — Context 게이지 + compaction 가시화  *(프론트 전용, 최소 변경)*

사이드카/Rust: **변경 없음**(데이터 완비).

프론트:
1. `agent/chat/types.ts` `DoneEvent`에 필드 추가:
   ```ts
   usage?: {
     input_tokens: number
     output_tokens: number
     cache_read_input_tokens?: number
     cache_creation_input_tokens?: number
   }
   totalCostUsd?: number | null
   ```
2. `agent/chat/index.ts` `claude:done` 리스너(`settleOk` 부근 L250): `usage`에서
   `contextTokens = input_tokens + (cache_read ?? 0) + (cache_creation ?? 0)` 계산해 store에 기록.
3. `ThreadMeta`에 `contextTokens?: number`, `lastCostUsd?: number` 추가 + `updateMeta`로 persist
   (리로드 후에도 게이지 유지).
4. 신규 `lib/contextLimit.ts`: `contextLimitForModel(model)` → 기본 200_000.
5. 신규 `ContextGauge.tsx`: `PromptInput` 푸터(EffortButton 왼쪽)에 얇은 바 + `123k / 200k`.
   ≥80%에서 경고색.
6. compaction 가시화: `streamParser.ts handleEvent`에 분기 추가 —
   `ev?.type === 'system' && ev?.subtype === 'compact_boundary'` → system part 방출("이전 대화 요약됨").
   압축 후 다음 done의 `input_tokens`가 줄어 게이지 자동 리셋.

### 기능 B — Plan mode  *(백엔드 완비, 프론트 배선)*

Rust: **변경 없음**(`permission_mode` passthrough 존재).

프론트:
1. `RunChatArgs`(types.ts) + `agent/chat/index.ts`: `permissionMode?: PermissionMode` 추가.
   **invoke args(L312~)에 `permissionMode` 필드 추가** — 현재 누락된 한 줄.
2. plan일 때 이중 안전 스코프:
   - `relayTools = ['read_page', 'search_wiki']` (propose_* 제외)
   - `builtinTools = ['Read', 'Glob', 'Grep']` (Bash 제외 — Bash로 파일 변경 가능)
3. `ThreadMeta`에 `mode?: 'edit' | 'plan'`(기본 `edit`).
4. `PromptInput`: Plan/Edit 토글(푸터 왼쪽). `onModeChange` prop.
5. plan turn 결과에 "이 계획 실행" 버튼 → 같은 thread를 `mode='edit'`로 두고
   "위 계획대로 진행" 재실행(resume이라 계획 맥락 유지).
6. 검증: `permissionMode:'plan'`이 MCP `propose_*`를 막는지 1회 확인.
   (스코프 2번 덕에 막든 안 막든 디스크 변경 0 — 검증은 동작 이해용.)

### 기능 C — Fast mode  *(Opus 전용, SDK-native 경로 확인됨)*

사이드카 `server.mjs`:
1. `#runChat` params 구조분해에 `fastMode` 추가.
2. `settings` 객체(L608)에 추가:
   ```js
   settings: { autoCompactEnabled: true, fastMode: !!fastMode },
   ```

Rust `commands.rs`:
3. `ChatStartArgs`에 `#[serde(default)] pub fast_mode: Option<bool>` 추가 + params passthrough.

프론트:
4. `RunChatArgs` + `agent/chat/index.ts`: `fastMode?: boolean` 추가, invoke args에 전달.
   **Opus 아니면 강제로 false**(서버 거부 방지).
5. `ThreadMeta`에 `fastMode?: boolean`.
6. `chat/types.ts`에 `supportsFastMode(model)` = `model.startsWith('claude-opus')`.
7. `PromptInput`: 번개 토글 — model이 Opus일 때만 노출/활성. 비용 프리미엄 경고 tooltip.
8. (선택) 응답 메시지 `fast_mode_state`를 읽어 실제 'on'인지 배지 표시.

검증: Opus + `fastMode:true` 1회 호출 → 메시지 `fast_mode_state === 'on'` 확인.
계정에 fast mode 액세스 없으면 `'off'`/`'cooldown'`으로 떨어짐(에러 아님).

---

## 6. 우선순위

1. **기능 A (게이지)** — 데이터가 이미 끝까지 와 있어 변경량 최소·체감 최대. compaction 가시화와 묶음.
2. **기능 B (plan)** — 백엔드 완비, UX 가치 큼, relay 스코프로 안전.
3. **기능 C (fast)** — Opus 한정 + 계정 research-preview 액세스 의존이라 적용 범위 좁음.

## 7. 시작 전 확인 2가지
- `permissionMode:'plan'`이 MCP `propose_*` 쓰기 도구까지 막는가? (B의 검증)
- Anthropic 계정에 fast mode research-preview 액세스가 있는가? (C의 전제)

## 8. 출처
- Fast mode: https://platform.claude.com/docs/en/build-with-claude/fast-mode
- Agent SDK (TS) 레퍼런스: https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- 권한/permissionMode: https://docs.claude.com/en/docs/claude-code/sdk/sdk-permissions
- 설치 SDK 타입: `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.121_*/.../sdk.d.ts`
