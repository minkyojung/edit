# ADR: 위키 ingest 시스템 — daily → wiki append 자동화

작성: 2026-05-08
상태: **Accepted**

---

## Context

데일리 노트가 쌓이지만 영구 메모리(`wiki:*` 페이지) 로 안 옮겨지면 second brain 가치가 0. 사용자가 직접 정리하는 건 안 함이 default — agent 가 들어가서 daily 의 핵심 정보를 wiki 에 기록해줘야 함.

문제 영역 셋:

1. **언제 / 무엇을 추출** — daily 의 어느 줄을 어느 wiki 페이지에 어떤 모양으로
2. **어디에 꽂을지** — wiki 페이지 안의 정확한 위치 결정
3. **어떻게 사용자가 검토** — 자동 적용은 신뢰 깨짐, 별도 review 모달은 컨텍스트 분리

세 영역 각각에서 "코드가 똑똑함 vs LLM 이 똑똑함" 트레이드오프가 있었고, 결론은 일관되게 **LLM 쪽으로**.

## Decision

### 1. Append-only as inline marks

추출된 제안은 wiki 페이지 본문에 직접 쓰지 않음. **proofSuggestion 마크로 anchor word 위에 stamp**, 사용자가 accept 누르면 그제서야 본문 mutation. proof-sdk 마크 시스템 (ADR 2026-04-30 참조) 그대로 재사용.

```
ingest 트리거 → proposals 생성 → ingestStore 큐
사용자가 wiki 페이지 진입 → useApplyPendingMarks → 마크 stamp
사용자 accept → markdown 파싱 → 블록 노드 삽입
```

이유:
- 별도 review 모달 안 만듦 → context 그대로 (사용자가 그 위키 페이지에서 직접 봄)
- 같은 UI affordance (mark popover) 가 모든 AI 제안에 통일됨
- "Karpathy: 사용자가 agent 가 제안한 걸 검토" 패턴

### 2. Shape-aware page detection (`wikiShape.ts`)

위키 페이지마다 모양이 다름. 엔티티 페이지 (People) 는 `### Name\n- bullet` 의 반복, 로그 페이지는 `- timestamp` 시퀀스, prose 페이지는 자유 글. 같은 LLM 한테 "Sarah 추가해" 라고 해도 페이지마다 출력 형태가 달라야 함.

`detectShape()` 가 deterministic 하게 페이지 모양을 판정 (timeline > entity > list > prose 우선순위). 결과를 ingest 시스템 프롬프트에 넘김:

```
[USER People — entity]
[USER log — timeline]
```

LLM 이 이 라벨 보고 페이지마다 적절한 markdown 모양으로 emit.

### 3. LLM-quoted anchor (`anchorAfterText`)

처음엔 구조적 좌표 시도 — `anchorH3: "Sarah"` 같은 식별자 → 코드가 PM 트리 순회해서 섹션 끝 찾기. 작동하긴 했지만 **코드가 너무 똑똑함**. 페이지 모양 바뀌면 깨지고, 디버깅 어렵고, shape 마다 다른 로직 필요.

대안: LLM 이 페이지에서 **이미 있는 줄 하나를 그대로 echo** (`anchorAfterText: "- AI team"`). 코드는 string find 만:

```ts
const docText = view.state.doc.textBetween(...)
if (docText.includes(wanted)) return wanted
return lastWordAnchor(view) // fallback
```

장점:
- shape 무관 — entity / list / timeline 다 같은 메커니즘
- LLM 의 본기 (텍스트 인용) 활용. 좌표 추론보다 안정
- 디버깅 쉬움 — LLM 응답만 보면 어디 꽂힐지 즉시 보임
- 환각하면 fallback (페이지 끝) — 데이터 손실 0

### 4. Markdown 파싱 on accept (`markActions.ts`)

LLM 이 emit 한 `### Sarah\n- AI team` 을 마크 content 로 저장. accept 시 **`schema.text(content)` 로 plain text 박는 게 원래 코드** — 결과적으로 `### Sarah` 가 literal 글자로 doc 에 남았음 (heading 노드 X).

해결: Milkdown 의 `parserCtx` 를 editor 만들 때 추출해서 `editorViewStore` 에 넣어두고, `acceptMark` 의 `kind === 'insert'` 분기에서 `parser(content)` 호출 → 진짜 PM 블록 노드 (heading, bullet_list) 로 변환 → anchor 의 containing block 다음에 삽입. anchor 자체는 mark 만 제거.

같은 commonmark + gfm preset 을 쓰니 사용자 타이핑 / 클립보드 paste / accept 가 동일 파이프라인 → 라운드트립에서 attrs 손실 없음.

## Consequences

### Positive
- daily 의 정보가 자연스럽게 wiki 에 쌓임. 사용자 노력 0
- 위키 페이지가 진짜 위키처럼 렌더링됨 (heading / bullet 노드)
- shape 추가하기 쉬움 (`wikiShape.ts` 에 패턴 하나 추가만)
- 환각 / 라이브 페이지 변경 / LLM 출력 변동 모두 fallback 으로 흡수 — 깨지지 않음

### Negative
- 같은 줄이 페이지에 여러 번 등장하면 첫 매치 사용 (이론적 ambiguity, 실전 드묾)
- 옛 포맷 (`${anchor}\n\n${content}` 가 마크 content 에 prepend 되던 형태) 은 마이그레이션 없음 — 기존 enqueue 된 마크는 reject 로 정리해야 함
- 빈 페이지 seed 가 plain paragraph (`People`) — 헤딩으로 띄우면 더 깔끔하지만 미구현

### Notes for future
- **`/wiki` 인덱스** 미구현. `WikiView.tsx` 가 stub. 사이드바 클릭으로만 진입 가능
- **빈 페이지 heading seed** — `ensureAnchorViaTransaction` 도 파서 통과시켜 `## People` 헤딩으로 넣으면 일관성 ↑
- **stale proposal TTL** 없음. 며칠 안 본 제안 그대로 남음
- **dedup** 없음. idle 트리거 연속이면 같은 내용 중복 제안 가능

## Files

핵심:
- `src/agent/ingest.ts` — LLM 시스템 프롬프트, `IngestProposal` 스키마, Haiku 호출
- `src/agent/applyIngest.ts` — proposal → 마크 변환, `resolveAnchor` 로 `anchorAfterText` 처리
- `src/state/wikiShape.ts` — entity / list / timeline / prose deterministic 판정
- `src/editor/markActions.ts` — `acceptMark` 의 markdown 파싱 + 블록 단위 insert
- `src/state/editorViewStore.ts` — Milkdown parser 노출

지원:
- `src/state/ingestStore.ts` — pending proposal / log 큐 (localStorage 영속)
- `src/hooks/useApplyPendingMarks.ts` — 활성 wiki 페이지 진입 시 lazy stamp
- `src/layout/IngestProposalCard.tsx` — 사이드바 review 카드
- `src/state/wikiService.ts` — wiki:\* 카탈로그, custom page 생성
