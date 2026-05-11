# Wiki-LLM Writer — 전체 계획서

---

## 0. 현재 진행 상황 (2026-04-29 업데이트)

원래 계획에서 발견된 몇 가지 사실:
- Tiptap → **Milkdown** 으로 교체 (proof-sdk와 동일 ProseMirror 엔진 → 마크 시스템 직접 활용 가능)
- proof-sdk 의 핵심 가치 (글자 단위 provenance + suggestion 마크) 를 실제로 통합 완료
- 원래 계획의 "P4 (멀티 에이전트)" 는 보류, 대신 단일 에이전트 + provenance/suggestion 시스템 깊이 강화
- 현재 작업 브랜치: `minkyojung/shadcn-luma-plan` — UI 레이어 (shadcn 도입 + Bulk Actions)

### 완료한 것

| 영역 | 상태 |
|---|---|
| **P1: 코어 에디터 + Copyeditor 에이전트** | ✅ |
| **P2-A: 위키 메모리 코어** (belief 주입, persistent session, OAuth) | ✅ |
| **P2-B: 위키 편집 UI** (textarea 모달; 정식 에디터로 교체는 보류) | 부분 완료 |
| **에디터 ↔ proof-sdk 연결** (Hocuspocus + Yjs) | ✅ |
| **인라인 suggestion 마크 렌더링** (Y.Map → ProseMirror Decoration) | ✅ |
| **MCP suggest 도구** — 에이전트가 suggest_replace/insert/delete 호출 | ✅ |
| **수락/거절 키보드 흐름** — Tab/Esc + 자동 다음 마크 | ✅ |
| **클라이언트 사이드 텍스트 적용** + 단어 경계 정렬 (Intl.Segmenter) | ✅ |
| **글자 단위 작성자 추적** (proofAuthored 마크 + 사용자/AI 자동 마킹 + 시각화) | ✅ |
| **OAuth 흐름** (Sign in with Claude) + 계정 인디케이터 | ✅ |
| **메모리 라이터** (P3 일부) — 교열 대화 → belief 자동 업데이트 | ✅ |

### 다음으로 할 것 (가까운 순서)

세부는 `roadmap.md` 참조. PR 단위로 분리해서 진행.

1. **PR 1 — shadcn 도입 + Bulk Actions** ← 현재 브랜치
2. **PR 2 — Comment 마크** (proof-sdk의 다른 큰 축)
3. **PR 3 — 마우스 호버 액션 바**
4. **PR 4 — 작성자 통계 사이드 패널**
5. **PR 5 — 멀티 문서 지원**
6. **PR 6 — Wiki 에디터 정식화** (textarea → Milkdown)

### 보류/연기

- **P3 (Memory-writer 정식)**: belief 자동 업데이트는 simplest 형태로 동작 중. Extractor/Reconciler 정식 분리는 베타 사용 데이터 보고 결정.
- **P4 (멀티 에이전트, 하네스 추상화)**: 단일 에이전트 + provenance 가 잘 작동한 후로 미룸.

---

## 1. 제품 개요

카파시의 Wiki-LLM 개념을 기반으로, 사용자의 장기 기억을 continuously 업데이트하는 메모리 시스템 위에서 여러 AI 에이전트가 실시간으로 글쓰기를 보조하는 앱.

**핵심 가치**:
- 쓸수록 나를 더 잘 아는 에이전트
- 여러 에이전트가 동시에, 다른 관점에서 글을 개선
- 클론, 고스트라이팅 등으로 확장 가능한 기반

**초기 사용자**: 5-10명 베타 테스터

---

## 2. 확정된 기술 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 앱 프레임워크 | **Electron + TypeScript** | proof-sdk(Node.js)를 main process에서 직접 실행 가능. Tauri는 Node.js sidecar 필요해 이점 없음 |
| 에디터 | **Milkdown** | ProseMirror 기반 (proof-sdk와 동일 엔진). 마크 시스템 직접 활용 가능, Yjs collab 지원 |
| 협업 백엔드 | **proof-sdk fork** (MIT) | character-level provenance, real-time collab, agent HTTP bridge 제공 |
| 위키 저장소 | **proof-sdk 문서** | native markdown 저장 + 글자별 provenance. export 단계 불필요 (Spike A 검증) |
| **에이전트 SDK** | **`@anthropic-ai/claude-agent-sdk` 단일 사용** | 옵션 A — 사용자 Claude Pro/Max 구독을 OAuth로 활용. Messages API 분리 안 함 |
| **인증 모델** | **OAuth via `claude login`** | 사용자 결제 카드 등록 불필요. 베타 사용자 = Claude Pro 보유자 가정 |
| **위키 ↔ 에이전트 연결** | **System prompt 직접 주입** (Copyeditor) / **MCP 도구** (Memory-writer) | Latency 경로는 도구 round-trip 회피. 백그라운드는 도구 자유 |
| **세션 모델** | **1 글 = 1 세션 + autoCompactEnabled** | session_id 저장 + resume. 컨텍스트 한계는 SDK가 자동 압축 |
| 에이전트 트리거 | **idle 1.5초** (기본) + 단축키 | Pro quota 고려해 추후 5초로 조정 가능 |
| 메모리 업데이트 | **액션 트리거** | 비용/CPU 예측 가능, 디버깅 쉬움. 데몬은 P4 이후 |
| **모델 선택** | Copyeditor: **Haiku 4.5** / Memory-writer: **Sonnet 4.6** / 명시 분석: **Opus 4.7** | quota 절약 + 작업 난이도별 차등 |
| 메모리 소스 | **작성 글 + Gmail + 캘린더** | P2에서 글, P3에서 외부 소스 추가 |

---

## 2.1 Spike 검증 결과 (2026-04-28)

| Spike | 결과 | 핵심 발견 |
|---|---|---|
| **A. proof-sdk** | ✅ GO | HTTP API로 문서 생성/조회/edit 가능. `marks`에 `by: "ai:..."` 자동 기록. native markdown이라 export 불필요 |
| **B. MCP + claude-agent-sdk** | ✅ GO | `createSdkMcpServer`로 in-process MCP 등록. 에이전트가 자발적으로 도구 호출. 응답이 답변에 반영됨 |

검증된 아키텍처 — 모든 레이어 작동 확인.

---

## 2.2 Anthropic 엔지니어 관점 분석 (2026-04-28)

**핵심 통찰:** "읽기 전용이고 작고 천천히 변하는 데이터"는 도구가 아니라 **컨텍스트**.

도구 호출은 동적 액션용. 위키 belief처럼 정적 데이터를 도구로 만들면:
- LLM 호출 2번 (tool_use 결정 + 도구 결과 받고 답변)
- TTFT 2-5초 (vs system prompt 직접 주입 시 0.5-2초)
- 비용 2배 (input 토큰 2번 청구)

**경로 분리 원칙:**
- **Latency 경로** (사용자가 기다림): system prompt 주입, 도구 없음
- **Background 경로** (사용자 무관): 도구 자유, 멀티턴 OK

옵션 A에선 SDK는 동일하게 `claude-agent-sdk`, 다만 도구 정책과 세션 전략이 경로별로 다름.

---

## 3. 5-Layer 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│  L5  Application Surface  (Writer / Clone / Ghostwrite)     │
├─────────────────────────────────────────────────────────────┤
│  L4  Agent Orchestrator   (역할 분배 / 충돌 조정 / 정책)    │
├─────────────────────────────────────────────────────────────┤
│  L3  Multi-Harness Adapter (Claude / Codex / Gemini CLI)    │
├─────────────────────────────────────────────────────────────┤
│  L2  Collaboration Substrate  (proof-sdk fork)              │
├─────────────────────────────────────────────────────────────┤
│  L1  Wiki-LLM Memory Core  (장기 기억, 지속 업데이트)       │
└─────────────────────────────────────────────────────────────┘
```

각 레이어는 독립적으로 교체 가능하게 설계. 특히 L3(하네스)는 SDK 변화가 빠르므로 abstraction이 새면 즉시 하네스별 코드 분기.

---

## 4. L1 — Wiki-LLM Memory Core

### 4.1 데이터 모델 (3종류 노드)

| 종류 | 설명 | 예시 |
|---|---|---|
| **Entity** | 사람/회사/제품/개념 | "친구 A", "Conductor 앱" |
| **Episode** | 시간 있는 사건 | "2026-04-12 A와 점심" |
| **Belief** | 사용자의 의견/취향/스타일 | "짧은 문장을 선호함" |

모든 노드 = **proof-sdk 문서** (글자별 provenance 보존).  
LLM이 읽을 때만 마크다운으로 export → Anthropic prompt caching 적용.

### 4.2 Memory Writer 파이프라인

```
[신호] → Extractor → Reconciler → Wiki Edit → Index 갱신
```

- **신호**: 사용자 글, 문단 완성, Gmail, 캘린더
- **Extractor**: 새 텍스트에서 entity/episode/belief 후보 JSON 추출
- **Reconciler**: 기존 위키와 충돌 검사
  - 신규 → 자동 추가
  - 기존 갱신 → 자동 업데이트
  - 모순 발견 → `suggestion.add`로 사용자 review 요청 (자동 덮어쓰기 금지)
- **Wiki Edit**: proof-sdk `edit` op 사용. provenance `by: "ai:memory-writer from doc:{id} rev:{n}"`

### 4.3 MCP Tools (에이전트용 메모리 인터페이스)

```typescript
memory.search(query: string): WikiPage[]       // 관련 페이지 검색
memory.read_page(slug: string): WikiPage       // 페이지 전문 읽기
memory.propose_edit(slug, edit): void          // 수정 제안 (Reconciler 거침)
```

---

## 5. L2 — Collaboration Substrate (proof-sdk)

### proof-sdk fork 사용 범위

| 패키지 | 사용 여부 | 용도 |
|---|---|---|
| `doc-core` | ✅ | 문서 데이터 모델, provenance |
| `doc-server` | ✅ | 실시간 collab 서버, Yjs |
| `doc-store-sqlite` | ✅ | 로컬 SQLite 저장소 |
| `agent-bridge` | ✅ + 확장 | 에이전트 HTTP 인터페이스 |
| `doc-editor` | ❌ | 에디터 UI는 Tiptap으로 대체 |

### agent-bridge 확장 (fork에서 추가할 것)

기존 op 타입 외 추가:
- `memory.read` — 에이전트가 위키 접근 시 provenance에 기록
- `memory.cite` — suggestion에 위키 출처 링크
- `harness.delegate` — 어느 하네스가 만든 변경인지 기록

provenance 형식: `by: "ai:{harness-id}/{agent-role}"` (예: `"ai:claude-code/copyeditor"`)

### Milkdown ↔ proof-sdk 연결

```
Milkdown (ProseMirror + Yjs collab service)
    ↕  HocuspocusProvider (WebSocket)
proof-sdk doc-server (Yjs)
    ↕
SQLite (로컬 저장)
```

provenance marks = Milkdown/ProseMirror plugin (`markPlugin.ts`, `proofAuthored` mark) 으로 구현.  
suggestion UI = Y.Map('marks') → ProseMirror Decoration 인라인 렌더링 (사이드바 아님).

---

## 6. L3 — Multi-Harness Adapter

### Harness 인터페이스

```typescript
interface Harness {
  id: "claude-code" | "codex" | "gemini-cli";
  spawn(opts: {
    workdir: string;
    systemPrompt: string;
    tools: MCPTool[];
    memory: MemoryHandle;
    onEvent: (e: HarnessEvent) => void;
  }): Promise<Session>;
}

type HarnessEvent =
  | { type: "thinking" }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "edit"; docId: string; op: ProofOp }
  | { type: "message"; role: string; text: string }
  | { type: "done"; usage: Usage; cost: number };
```

**원칙**:
- 모든 출력은 proof-sdk op으로 정규화 (어느 하네스든 에디터 입장에서 동일)
- Tool은 MCP 형식. Claude/Codex는 MCP 직접, Gemini는 함수 호출 → MCP 어댑터
- 시스템 프롬프트는 **하네스별 최적화 허용** — 공통화하면 품질 저하
- Abstraction이 새면 즉시 하네스별 분기. 가짜 통일성 유지하지 않음

### P1 타겟: Claude Code 어댑터

- Anthropic SDK + **prompt caching 필수** (위키 페이지 매 턴 주입 → 캐시 없으면 비용 폭발)
- MCP 서버 2개 노출: `proof-bridge` (편집), `memory` (L1 접근)

---

## 7. L4 — Agent Orchestrator

### 에이전트 역할 (P1: 1개, P4: 4개)

| 에이전트 | 권한 | 트리거 | Phase |
|---|---|---|---|
| **Copyeditor** | `suggestion.add` | idle 1.5초 | P1 |
| **Fact-checker** | `comment.add` (위키 인용) | 문단 완성 | P4 |
| **Voice-mimic** | `suggestion.add` (스타일) | 톤 일탈 감지 | P4 |
| **Memory-writer** | 위키 문서 `edit` | 문단 완성 (백그라운드) | P3 |

### 충돌 조정 규칙

- 같은 단락에 두 에이전트가 동시 suggestion → orchestrator가 merge (둘 다 표시) 또는 dedupe (의미 중복이면 하나만)
- `rewrite.apply` (파괴적 op)는 사용자 명시 승인 없이 **절대 금지**
- 사용자 타이핑 중인 단락은 **읽기 전용** — idle 이후에만 mutation 허용

---

## 8. L5 — Application Surfaces

같은 L1-L4 위에서 세 제품이 자연스럽게 파생:

| 제품 | 에이전트 권한 | 자동화 수준 |
|---|---|---|
| **Real-time Writer** | suggestion.add, comment.add | 에이전트 제안 → 사용자 수락 |
| **Clone** | 자동 apply 허용 | 사용자 페르소나로 자동 답신/포스팅 |
| **Ghostwriter** | suggestion.add만 | 모든 변경 사용자 승인 후 적용 |

차이는 **에이전트 권한 레벨과 자동화 정도**뿐. 코어는 동일.

---

## 9. Phase 계획

### P1 (Week 1-3) — 코어 에디터 + 단일 에이전트

**목표**: 글 쓰고 멈추면 에이전트 suggestion이 붙는 경험 작동

| 작업 | 상태 |
|---|---|
| proof-sdk fork | ✅ 완료 (git submodule) |
| Electron 앱 | ✅ 완료 (Tiptap + idle 1.5초 hook) |
| Suggestion UI (sidebar) | ✅ 완료 (streaming) |
| Copyeditor 에이전트 (claude-agent-sdk) | ✅ 완료 (지금은 매 trigger마다 새 query) |
| Milkdown ↔ proof-sdk 실시간 동기화 | ✅ 완료 (HocuspocusProvider + Yjs) |
| Provenance marks (proofAuthored) | ✅ 완료 (P4 일부 선반영, AI/사람 글자 단위 추적) |

**완료 기준**: 글 쓰고 1.5초 멈추면 Copyeditor suggestion이 사이드바에 나타남 ✅

---

### P2 (Week 4-6) — 위키 메모리 코어

**목표**: 에이전트가 위키를 읽고 suggestion에 반영

#### P2-A: 최소 구현 (지금 진행 중)

| # | 작업 | 상태 |
|---|---|---|
| 1 | 위키 부트스트랩 (`wikiService.ts`) — 앱 시작 시 belief 문서 보장, slug+token 영구 저장 | ✅ |
| 2 | **Persistent session 리팩토링** — 1글=1세션 ✅ (`agentService.ts:140-169`). session_id 영구 저장/resume은 미구현 | ⏳ 부분 |
| 3 | **위키를 system prompt에 직접 주입** — `agentService.ts:173-177` belief markdown을 systemPrompt 배열에 prepend | ✅ |
| 4 | **`autoCompactEnabled: true`** — options에 명시 안 됨 (SDK 기본 동작에 의존). compact_boundary 이벤트는 관찰됨 | ❌ |
| 5 | **모델 = Haiku 4.5** + `effort: low` — 모델은 Haiku ✅, `effort: low` 미설정 | ⏳ 부분 |
| 6 | 위키 변경 시 세션 재시작 — `index.ts:92-95` wiki:save → resetSession() → `interrupt()` | ✅ |
| 7 | OAuth 상태 onboarding — `App.tsx:260-283` SignInPanel + 스플래시, `oauthService.ts` PKCE 흐름 | ✅ |

**P2-A 잔여 작업** (다음 후속):
- session_id 영구 저장 + `resume` 옵션으로 재시작 시 컨텍스트 복원
- `autoCompactEnabled: true` 명시 설정
- Copyeditor query 옵션에 `effort: 'low'` 추가

#### P2-B: 위키 편집 UI

| 작업 | 세부 |
|---|---|
| 위키 페이지 분리 | belief / entity / episode 3개 문서로 확장 |
| 위키 에디터 탭 | 앱 내 별도 탭에서 Milkdown으로 위키 편집 (현재는 textarea 모달 — 정식화는 PR 6) |
| Milkdown ↔ proof-sdk 연결 | ✅ HocuspocusProvider + Yjs (`MilkdownEditor.tsx:48-53`, `App.tsx:200-224`) |
| Memory MCP tools (background용) | `wiki.read_page(slug)`, `wiki.search(query)` — Memory-writer 준비 |

#### P2-C: 베타 온보딩

| 작업 | 세부 |
|---|---|
| Quota 모니터링 | 매 turn `result.usage` 기록, UI에 일일 사용량 표시 |
| Rate limit pre-warning | 90% 도달 시 사용자 안내 |
| 베타 사용자 5-10명 초대 | 로컬 데이터, 계정 시스템 미니멀 |

**완료 기준**: 위키에 스타일 preference가 있으면 에이전트가 그것을 기반으로 suggestion 생성. TTFT 1초 이내. quota 90% 도달 시 경고 표시.

---

### P3 (Week 7-10) — 메모리 자동 업데이트

**목표**: 쓸수록 위키가 자동으로 자라남

| 작업 | 세부 내용 |
|---|---|
| Extractor 에이전트 | 문단 완성 시 entity/episode/belief 후보 JSON 추출 |
| Reconciler | 기존 위키 충돌 검사. 모순 시 사용자 review 요청 |
| Memory-writer 에이전트 | 위키 proof-sdk 문서에 `edit` op 자동 적용 |
| Gmail 연결 | Gmail API → Extractor 파이프라인 |
| 캘린더 연결 | Google Calendar API → episode 자동 생성 |
| `memory.propose_edit` | MCP tool 추가 — Reconciler 거쳐 위키 수정 |

**완료 기준**: 일주일 사용 후 위키가 사용자 손 없이 의미 있게 자람

---

### P4 (Week 11-14) — 멀티 에이전트 + 하네스 확장

**목표**: 동시에 여러 에이전트가 다른 관점에서 보조

| 작업 | 세부 내용 |
|---|---|
| Fact-checker 에이전트 | 사실 주장에 위키 인용 comment 추가 |
| Voice-mimic 에이전트 | 위키 belief에서 사용자 스타일 추론 → 톤 일탈 감지 |
| Agent Orchestrator | L4 구현: 3개 에이전트 동시 실행, 충돌 조정 |
| Harness 인터페이스 추상화 | `Harness` 인터페이스 분리 + Codex 어댑터 추가 |
| 오버레이 프로토타입 | macOS Accessibility API로 다른 앱 위 suggestion (실험적) |

**완료 기준**: Copyeditor/Fact-checker/Voice-mimic 세 에이전트가 동시에 다른 색으로 suggestion 표시

---

## 10. 타임라인 요약

```
Week  1-3   P1  에디터 + 단일 에이전트 (Copyeditor)
Week  4-6   P2  위키 메모리 코어 + 에이전트 통합
Week  7-10  P3  메모리 자동 업데이트 + 외부 소스 (Gmail, 캘린더)
Week 11-14  P4  멀티 에이전트 + 하네스 레이어
```

**원칙**: P1이 reliable하게 작동하기 전에 P2 시작하지 않음. 각 Phase는 완료 기준을 충족해야 다음으로.

---

## 11. Reliability 원칙 (전체 적용)

- `rewrite.apply` 등 파괴적 op은 사용자 명시 승인 없이 실행 불가
- 메모리 Reconciler는 모순 발견 시 자동 덮어쓰기 금지 → 사용자 review
- 에이전트 변경에는 항상 provenance (`by: "ai:{harness}/{role}"`) 기록
- 사용자 타이핑 중 단락은 에이전트 mutation 대상에서 제외
- 외부 소스(Gmail 등) 에서 온 메모리는 반드시 사용자 확인 후 적용

---

## 12. 옵션 A 운영 원칙 (Pricing & Auth)

- 인증: 사용자 본인의 `claude login` (OAuth) — 우리 앱은 API 키 보유 안 함
- 베타 사용자 = Claude Pro/Max 보유자 가정. 미보유자는 onboarding에서 안내 후 차단
- Quota는 사용자 구독 한계 내. 우리 앱은 **읽기 전용 모니터링** + 사용자 보호 (90% 경고, 100% 차단)
- Latency 경로 (Copyeditor) 는 **session-level prompt caching** 으로 비용/속도 절감 — persistent query + 안정된 system prompt 필수
- Background 경로 (Memory-writer P3) 는 사용자 idle 5분+ 시점에만 spawn, quota 사용자 인지 가능하도록 표시

## 13. SDK 사용 정책

| 경로 | SDK | 모델 | 도구 | 세션 |
|---|---|---|---|---|
| Copyeditor | `@anthropic-ai/claude-agent-sdk` | `claude-haiku-4-5` | 없음 (위키는 system prompt) | 1글=1세션, persistent |
| Memory-writer (P3) | `@anthropic-ai/claude-agent-sdk` | `claude-sonnet-4-6` | `mcp__wiki__*` 다수 | 작업 단위 spawn |
| 명시 분석 (P4) | `@anthropic-ai/claude-agent-sdk` | `claude-opus-4-7` (effort: xhigh) | 도구 자유 | 작업 단위 spawn |

`@anthropic-ai/sdk` (Messages API) 는 **사용 안 함** — OAuth 미지원이라 옵션 A와 호환 안 됨.
