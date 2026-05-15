# Phase 4 — ingest.ts 분해

**기간**: 1.5주
**선행**: Phase 3 완료 (proof-sdk 제거 + 회귀 안정)
**목적**: `apps/writer-tauri/src/agent/ingest.ts` 709줄을 4개 파일로 분해. 동작 변화 0 — 순수 리팩토링.

## 현재 ingest.ts 의 책임 (한 파일에 다 들어 있음)

| 책임 | 위치 (대략) |
|---|---|
| 타입 정의 (`IngestProposal`, `IndexUpdate`, `IngestResult`) | `ingest.ts:48~159` |
| 시스템 프롬프트 정적 부분 (`SYSTEM_PROMPT_STATIC`) | `ingest.ts:168~210` (~50줄 인라인 문자열) |
| 사용자 프롬프트 조립 (Karpathy 패턴: index + wiki + conventions + log + new note) | `ingest.ts:230~390` (~160줄) |
| LLM 호출 (sidecar invoke + tool listen) | `ingest.ts:400~520` |
| 응답 파싱 (JSON shape 검증, sanitize, bullet 정리) | `ingest.ts:390~550` (`validateParsed` 등) |
| `assembleProposalMarkdown` 헬퍼 | `ingest.ts:89~113` |
| 진입점 `runIngest` (워터마크 + readDoc + 위 단계 오케스트레이션) | `ingest.ts:550~709` |

## 분해 계획

```
src/agent/ingest/
├── index.ts        — 외부 진입점 + 오케스트레이션 + 워터마크 (~100줄)
├── types.ts        — IngestProposal / IndexUpdate / IngestResult 등 (~80줄)
├── prompts.ts      — SYSTEM_PROMPT_STATIC + 사용자 프롬프트 조립 (~250줄)
├── parse.ts        — LLM 응답 → 검증된 IngestResult (~200줄)
└── markdown.ts     — assembleProposalMarkdown (~30줄)
```

호환을 위해 기존 `apps/writer-tauri/src/agent/ingest.ts` 는 다음으로 변경:
```ts
// Re-exports for backward compatibility — Phase 4 split.
export * from './ingest/index'
export * from './ingest/types'
export { assembleProposalMarkdown } from './ingest/markdown'
```

또는 호출자를 모두 새 위치로 갱신 후 `ingest.ts` 삭제. 호출자 적으면 후자.

## 파일별 세부

### types.ts

이동 대상:
- `IngestProposal` (`ingest.ts:48~87`)
- `IndexUpdate` (`ingest.ts:121~130`)
- `IngestResult` (`ingest.ts:132~159`)

순수 타입 모듈. import 0.

### markdown.ts

이동 대상:
- `assembleProposalMarkdown(proposal, options)` (`ingest.ts:101~113`)

작은 헬퍼. 별도 모듈로 둠 — Phase 6 의 lint/queryWiki 도 같은 헬퍼 쓸 가능성.

### prompts.ts

이동 대상:
- `SYSTEM_PROMPT_STATIC` 상수 (긴 문자열)
- 사용자 프롬프트 조립 함수들: index 블록 / wiki 블록 / conventions / log / 새 note 부분
- `composeUserPrompt(args)` 같은 단일 export — 입력은 모든 위키 컨텍스트 + 사용자 노트, 출력은 모델에 보낼 문자열

```ts
// prompts.ts (대략)
export const SYSTEM_PROMPT_STATIC = `...`

interface ComposeArgs {
  conventions: string
  index: string
  wiki: Array<{ typeId: string; title: string; body: string }>
  log: string
  newNote: { date: string; body: string }
  unseenBlocks: string[]  // pickNewBlocks 결과
}

export function composeUserPrompt(args: ComposeArgs): string {
  // Karpathy 패턴: [CONVENTIONS] [INDEX] [WIKI] [LOG] [NEW NOTE]
}
```

prompts.ts 의 export 는 시스템 프롬프트 + composeUserPrompt 2개. 내부에 작은 helper 들 (formatWikiBlock 등) 두고 export 안 함.

### parse.ts

이동 대상:
- LLM tool 결과 → `IngestResult` 변환
- JSON shape 검증 (`validateParsed`)
- bullet sanitize (markdown 헤더 제거, 빈 줄 정리)
- malformed fallback

```ts
// parse.ts (대략)
export function parseIngestResult(rawTool: unknown): {
  result: IngestResult
  malformed: boolean
} {
  // 1. raw 가 tool args (object) 인지 검증
  // 2. proposals / indexUpdates / logEntry 각각 검증
  // 3. sanitize bullets
  // 4. 못쓸 entry 는 drop, 로그
  // 5. IngestResult 반환
}
```

### index.ts (오케스트레이션)

이동 대상:
- `runIngest(noteSlug)` 진입점
- 워터마크 체크 (lastIngestedAt / ingestedBlockHashes)
- readDoc + readWikiContext (`wikiService` 호출)
- composeUserPrompt → invoke sidecar → onTool listen → parseIngestResult
- ingestStore 에 결과 push

```ts
// index.ts (대략)
import { composeUserPrompt, SYSTEM_PROMPT_STATIC } from './prompts'
import { parseIngestResult } from './parse'
import { readWikiContext, readConventions, readIndexContext } from '@/state/wikiService'
import { pickNewBlocks } from '@/lib/blockHash'

export async function runIngest(noteSlug: string): Promise<IngestResult> {
  // 1. 가드 (이미 빈 노트, 워터마크 등)
  // 2. 위키 컨텍스트 조립
  // 3. composeUserPrompt
  // 4. claude_chat_start invoke
  // 5. tool 이벤트 listen → submit_ingest_result 받음
  // 6. parseIngestResult
  // 7. 반환 (호출자가 ingestStore 에 push)
}
```

## 호출자 영향

- `apps/writer-tauri/src/hooks/useIdleTrigger.ts` — `runIngest` import
- `apps/writer-tauri/src/state/docsStore.ts` — `runIngest` import (있다면)
- `apps/writer-tauri/src/agent/applyIngest.ts` — `IngestProposal` type 사용
- `apps/writer-tauri/src/layout/WikiPageBanner.tsx` — `IngestProposal` 등 사용

→ import path 만 바뀜. 기능 동작은 같음.

## 검증

**원칙**: 순수 리팩토링 phase. 동작 변화 0 보장.

1. **단위 테스트** (가능하면 추가):
   - `composeUserPrompt` 의 출력이 변경 전 ingest.ts 의 같은 입력 결과와 byte-identical
   - `parseIngestResult` 가 알려진 LLM 출력 fixture 에 대해 같은 IngestResult 생성

2. **통합 검증** (현재도 자동 테스트 없으면 수동):
   - daily 노트 작성 → 자동 ingest → 위키 페이지 banner 카드 (Phase 2/3 시나리오와 동일)
   - banner accept → 위키 페이지에 정상 들어감
   - 워터마크 동작: 같은 노트 두 번 저장 → 두 번째 호출에서 이미 본 block skip 됨
   - logEntry 가 system:log 페이지에 append 됨

3. **회귀 확인**:
   - Phase 2/3 의 회귀 시나리오 모두 통과
   - propose_change tool 호출 수 / token 사용량 변화 없음 (sidecar 로그)

## 분해 시 발견할 수 있는 문제 (대응 미리)

### (a) 함수 간 숨은 의존
- prompts.ts 가 parse.ts 의 helper 를 쓰는 경우 → 공유 helper 를 별도 작은 파일로 (`internal.ts`)
- types.ts 가 다른 도메인 타입을 import → 도메인 별 타입 분리

### (b) 인라인 상수 / regex
- ingest.ts 안에 `const SYSTEM_PROMPT_STATIC` 외에도 작은 regex / 상수 있음. 각각 의미상 맞는 파일로.

### (c) 함수가 너무 많은 외부 의존을 받음
- `runIngest` 가 docsStore, ingestStore, wikiService 모두 import. 분해 시 한 곳에 몰아두는 게 자연스러우면 index.ts 에 그대로. 깊은 분해 ($DI 같은) 안 함 — 과한 추상화 회피.

## 완료 기준

- [ ] 4~5개 파일로 분해 완료
- [ ] 컴파일 통과 (모든 import path 정상)
- [ ] 단위 테스트 통과 (composeUserPrompt + parseIngestResult fixture 기반)
- [ ] Phase 2/3 회귀 테스트 그대로 통과
- [ ] ingest.ts 의 총 줄 수가 한 파일 기준 ~250줄 이하로 (가장 큰 파일 = prompts.ts)
- [ ] 어떤 파일도 400줄 넘지 않음

## 다음 단계
Phase 5 — `chat.ts` 666줄을 같은 패턴으로 분해.

## 위험

| 위험 | 완충 |
|---|---|
| 분해 중 동작 미묘하게 바뀜 (e.g. SYSTEM_PROMPT_STATIC 의 trailing whitespace) | 분해 전 fixture 캡처 (한 번의 ingest 입출력 byte-by-byte 저장) → 분해 후 같은 입력에 같은 출력 확인 |
| 호출자 import 모두 갱신 빠뜨림 | barrel re-export 로 우선 호환 유지. 별도 PR 에서 호출자 import 정리 |
| LLM 응답 파싱 로직이 prompts.ts 와 결합되어 분리가 부자연스러움 | parse 가 prompts 의 정적 부분만 알면 됨 (모델이 따르는 JSON 스키마). 두 파일이 같은 type (e.g. `submit_ingest_result` 의 tool input schema) 을 공유하면 types.ts 에 둠 |
| 분해 작업이 사용자 가시 기능에 영향 주는 변경과 섞임 | 이 phase 는 "오직 분해만". 작은 cleanup (변수명 개선 등) 도 별도 PR. |
