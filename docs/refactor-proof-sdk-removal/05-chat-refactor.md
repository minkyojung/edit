# Phase 5 — chat.ts 분해

**기간**: 1주
**선행**: Phase 4 완료
**목적**: `apps/writer-tauri/src/agent/chat.ts` 666줄을 3~4개 파일로 분해. Phase 4 와 같은 패턴 — 순수 리팩토링, 동작 변화 0.

## 현재 chat.ts 의 책임

| 책임 | 위치 (대략) |
|---|---|
| `runChat` 진입점 (sidecar invoke + stream listen) | `chat.ts:200~540` |
| 이벤트 → MessagePart 변환 (text / reasoning / tool) | `chat.ts:300~480` |
| Tool 상관 (`blockIndexToPartId`, `toolInputFragments` 맵) | `chat.ts:380~500` |
| Proposal listener (propose_change → applyProposal) | `chat.ts:544~620` |
| System prompt 조립 (multi-block + dynamic boundary) | `chat.ts:80~180` |
| 타입 정의 (`RunChatArgs`, `ToolCallRecord` 등) | `chat.ts:54~120` |

## 분해 계획

```
src/agent/chat/
├── index.ts             — runChat 진입점 + 오케스트레이션 (~150줄)
├── types.ts             — RunChatArgs / ToolCallRecord / 등 (~50줄)
├── systemPrompt.ts      — system prompt 조립 + DYNAMIC_BOUNDARY (~120줄)
├── streamParser.ts      — sidecar 이벤트 → MessagePart 변환 + tool 상관 (~250줄)
└── proposalListener.ts  — propose_change → applyProposal (markStore) 라우팅 (~100줄)
```

호환: `apps/writer-tauri/src/agent/chat.ts` 를 `export * from './chat/index'` 형태 barrel 로.

## 파일별 세부

### types.ts

이동 대상:
- `RunChatArgs` (`chat.ts:61~120`)
- `ToolCallRecord` (`chat.ts:54~59`)
- 내부 이벤트 union 타입 (claude:event / claude:proposal / claude:done / claude:error 의 payload shape)
- `agentIdForModel(model)` 헬퍼 (단순 헬퍼 — types 와 같이 두거나 별도 utility 로)

### systemPrompt.ts

이동 대상:
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 상수 (`chat.ts:30`)
- system prompt multi-block 조립 로직 — FREE_CHAT_PROMPT + 문서 컨텍스트 + wiki 컨텍스트
- `appendDocument` 옵션 분기
- `composeSystemBlocks(args)` 단일 export

이유: chat.ts 의 system prompt 조립이 길고, 캐시 보존을 위해 정적/동적 분리. 이 부분은 별도 모듈로 떼면 향후 다른 흐름 (예: queryWiki) 도 같은 패턴 재사용 가능.

### streamParser.ts

이동 대상:
- `blockIndexToPartId` 맵 — assistant content block index ↔ MessagePart id 매핑
- `toolInputFragments` 맵 — tool_use 의 input 이 여러 fragment 로 도착할 때 합치는 버퍼
- claude:event 처리 (text delta / reasoning delta / tool_use 시작/끝)
- MessagePart 빌더 (`makeTextPart`, `makeReasoningPart`, `makeToolPart`)

이 부분이 chat.ts 의 가장 복잡한 영역. 단위 테스트 추가 권장:

```ts
// streamParser.test.ts
test('text delta accumulates into single TextPart', ...)
test('tool_use with fragmented input is reassembled', ...)
test('reasoning before text creates two ordered parts', ...)
test('stop_reason terminates current parts', ...)
```

### proposalListener.ts

이동 대상:
- `claude:proposal` 이벤트 리스너 (`chat.ts:544~620`)
- `applyProposal` 호출 + `onToolApplied` 콜백 호출
- mark id 수집 (이미 cleanup 호출자가 쓸 수 있도록 onPart 측에 ToolPart 결과로 반영)

```ts
// proposalListener.ts (대략)
import { applyProposal } from '../applyProposal'

export function createProposalListener(args: {
  slug: string
  agentId: string
  runId: string
  onApplied: (call: ToolCallRecord) => void
}): (proposal: Proposal) => Promise<void> {
  return async (proposal) => {
    const outcome = await applyProposal(args.slug, proposal, {
      runId: args.runId,
      agentId: args.agentId,
    })
    args.onApplied({
      id: outcome.ok ? outcome.markId : `failed-${Date.now()}`,
      name: 'propose_change',
      input: proposal,
      result: outcome,
    })
  }
}
```

Phase 2 후 `applyProposal` 자체는 `markStore.add` 호출이라서 이 listener 는 markStore 직접 의존 0.

### index.ts (오케스트레이션)

이동 대상:
- `runChat(args)` 진입점
- 사이드카 invoke (`claude_chat_start`)
- listen 4종 (event / proposal / done / error)
- streamParser + proposalListener 결합
- abort 처리 (`useChatRuns.abort`)

```ts
// chat/index.ts (대략)
import { composeSystemBlocks } from './systemPrompt'
import { createStreamParser } from './streamParser'
import { createProposalListener } from './proposalListener'

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const parser = createStreamParser({ onPart: args.onPart })
  const onProposal = createProposalListener({ slug: args.slug, agentId: agentIdForModel(args.model), ... })

  const unlisteners = await Promise.all([
    listen('claude:event', (e) => parser.handleEvent(e.payload)),
    listen('claude:proposal', (e) => onProposal(e.payload)),
    listen('claude:done', (e) => parser.handleDone(e.payload)),
    listen('claude:error', (e) => parser.handleError(e.payload)),
  ])

  try {
    await invoke('claude_chat_start', { /* ... */ })
    return await parser.awaitSettle()
  } finally {
    unlisteners.forEach((un) => un())
  }
}
```

## 검증

**원칙**: 동작 변화 0.

1. **단위 테스트** (streamParser 만이라도):
   - text delta 누적 → 단일 TextPart
   - tool_use fragment 재조립
   - parts 순서 (reasoning → text → tool 등)
   - stop_reason 종료 처리

2. **통합 검증**:
   - chat 한 턴 정상 흐름: 사용자 메시지 → AI 응답 streaming → 완료
   - propose_change tool 호출 시 위키 페이지에 마크 박힘 (Phase 2 와 동일)
   - thinking blocks 정상 표시 (reasoning part)
   - 도구 결과 streaming 중 abort → 정상 종료
   - 네트워크 끊김 (offline) → 1초 내 에러 처리

3. **회귀**:
   - Phase 2 / 3 / 4 시나리오 모두 통과
   - sidecar token usage 변화 없음 (system prompt cache 보존 확인)

## 분해 시 발견할 수 있는 문제 (대응 미리)

### (a) blockIndexToPartId 의 lifecycle
이 맵은 runChat 함수 스코프에 살아 있는 mutable state. streamParser 모듈로 옮길 때 closure / class 둘 중 선택:
- closure (factory + return handlers) — 가벼움, 권장
- class — testable 하긴 한데 우리 코드 스타일과 안 맞음

→ closure 권장. `createStreamParser(...)` 가 `{ handleEvent, handleDone, awaitSettle, ... }` 반환.

### (b) abort 처리의 cross-cutting
`useChatRuns.abort()` 가 cancel signal 을 들고 와서 sidecar 에 전달. 이 흐름이 chat/index.ts 에 남음 (스트림과 무관 — 라이프사이클).

### (c) 한 listener 가 여러 모듈 의존
proposalListener 가 applyProposal 호출. streamParser 가 useChatRuns 확인. 의존이 자연스러우면 그대로 두고, 분리가 더 복잡하면 index.ts 가 모든 의존을 모으는 패턴.

## 완료 기준

- [ ] 5개 파일로 분해 완료
- [ ] 컴파일 통과
- [ ] streamParser 단위 테스트 4~6개 통과
- [ ] Phase 2 ~ 4 회귀 테스트 통과
- [ ] chat.ts 각 파일 ~250줄 이하
- [ ] system prompt cache hit 비율 변화 없음 (sidecar log 확인)

## 다음 단계
Phase 6 — Wiki LLM 완성 (queryWiki + lint + 시간 메타 + 링크 사전검증). 신규 기능.

## 위험

| 위험 | 완충 |
|---|---|
| streamParser 의 미묘한 race (이벤트 순서 의존) | 단위 테스트로 시나리오 lock-in. event ordering 가정 명문화 |
| `useChatRuns.abort` 와 unlisten 사이의 race | 기존 코드의 try/finally 패턴 그대로 유지. 변경 안 함 |
| 분해 후 system prompt 의 dynamic boundary 위치 미묘하게 달라짐 → 캐시 miss | 분해 전 prompt byte snapshot → 분해 후 같은 입력에 byte-identical 확인 |
| proposalListener 가 applyProposal 의 reason 코드와 결합되어 분리 어색 | reason 코드 자체는 Phase 0 의 markStore 인터페이스에 명시되어 있으므로 자유롭게 import |
| 사용자 가시 기능에 영향 주는 변경과 섞임 | 이 phase 는 "오직 분해만". 작은 cleanup 도 별도 PR |
