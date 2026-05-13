# ADR: wiki ingest 검토 surface 를 proofSuggestion 마크에서 banner inbox 로 이전

작성: 2026-05-13
상태: **Accepted**
관련: `2026-05-08-wiki-ingest-system.md`, `2026-05-10-proof-sdk-realignment.md`
참고: `docs/llm-wiki-redesign-plan.md` (5번 항목)

---

## Context

`2026-05-10-proof-sdk-realignment.md` 에서 wiki ingest 의 검토 모델을 proof-sdk 의 `ops/suggestion.add` 패턴 (anchor 는 기존 doc 텍스트, content 는 Y.Map 메타) 으로 정합시켰음. server drift 0, Cmd+Z 정합, ghost widget inline preview 라는 결과는 얻었지만 그 자체로 다섯 가지 어색한 우회가 남음:

1. `lastWordAnchor()` — anchor 가 의미를 운반하지 않음. 페이지 마지막 단어를 임의로 씀.
2. `ensureAnchorViaTransaction()` — 빈 페이지에 anchor 박을 단어가 없으니 페이지 제목을 가짜 paragraph 로 seed.
3. multi-block markdown 을 PM 에 못 넣음 (server drift) → `Decoration.widget` 클라 전용 렌더. 텍스트 선택 / pre-accept 편집 불가.
4. cross-doc 큐 (`ingestStore`) + `useApplyPendingMarks` lazy materialize. 마크 가 cross-doc 비동기로 만들어지는 패턴이 proof-sdk 가정과 안 맞음.
5. PM transaction + Y.Map 이중 쓰기를 `ydoc.transact('mark-action')` 으로 묶어 atomic 보장 (이건 패턴상 필요한 가드라 유지되지만, 위 4 개를 받쳐주는 보강 코드).

근본 원인 분석 (`docs/llm-wiki-redesign-plan.md` 5 번):

> proofSuggestion 마크 = "사용자가 글 쓰는 중 AI 가 그 글의 특정 범위에 인라인 제안" 용도.
> wiki ingest = "다른 문서로 새 콘텐츠 합성, 사용자는 그 문서 열 때 검토" 용도.
> 의미가 다른 두 작업을 같은 도구에 끼워 맞춰서 5 개 우회 누적.

Karpathy LLM Wiki 의 원형 (`https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`) 도 검토 UI 에 대한 별도 가정 없음 — markdown 갱신은 단순 ingest, 검토 surface 는 자유 설계.

## Decision

**wiki ingest 의 검토 surface 를 in-page banner inbox 로 분리.** proof-sdk 마크 시스템은 인라인 댓글/제안 본연 용도로만 사용.

### Banner surface (`apps/writer-tauri/src/layout/WikiPageBanner.tsx`)

```
사용자가 wiki 페이지 진입 → 그 페이지 type 매칭 proposals 가 banner 카드로 렌더
  Accept → parser(content) → PM Fragment → 문서 끝에 insert
           + proofAuthored 마크 stamp on 새 범위
           + Y.Map('authoredMeta') 에 source* + acceptedAt
           + ingestStore.remove
  Reject → ingestStore.remove only (페이지 미변경)
```

`proofAuthored` + `authoredMeta` 패턴은 `markActions.acceptMark(insert)` 가 이미 쓰던 모던 패턴. `proofProvenance` 는 ADR 2026-05-10 에서 server 가 모르는 mark 라 projection wipe 유발해서 isolated; 우리도 같은 함정을 안 밟음.

### applyIngest.ts 단순화

`applyOneAsMark`, `lastWordAnchor`, `ensureAnchorViaTransaction`, `applyPendingForActive` 전부 제거. `applyPendingLogsForView` 만 남김 (wiki:log 의 append-only timeline 은 그대로 — 거기엔 "검토" 가 없음).

### useApplyPendingMarks → useApplyPendingLogs

옛 훅은 wiki:log + 다른 wiki:* 둘 다 처리. 새 훅은 wiki:log 만. 마크 stamp 로직 전부 사라짐.

### 마이그레이션 (`useMigrateLegacyIngestMarks`)

기존 사용자 DB 에 박힌 옛 ingest origin proofSuggestion 마크 + Y.Map('marks') 엔트리를 사용자가 해당 wiki 페이지 첫 진입 시 일괄 제거. ingestStore 의 대응 큐 엔트리는 stamp 시점에 이미 제거됐으므로 잃는 데이터는 없음 (재제안은 다음 ingest 패스가 생성).

idempotent — 옛 마크 없는 페이지는 단순 traversal + early return.

### 보존되는 것

- `proofSuggestion` 마크 자체 + `markDecoPlugin` 의 INSERT 분기: **채팅의 `propose_change(insert)` 흐름이 같은 surface 를 사용**. wiki ingest 만 빠지고 채팅용 ghost widget 은 그대로.
- `IngestProposalCard.tsx` (사이드바 푸터 "Wiki updates ready"): 전체 알림 surface 로 유지. "Review" 클릭 시 첫 target 페이지로 이동 → 그 페이지의 banner 가 카드 렌더. 두 surface 보완 관계.
- `suggestNewPage` 흐름 (`materializeNewPageProposals`): 그대로. 새 페이지 생성 + content 본문 seed. 큐에 들어오지 않으므로 banner 와 무관.

## Consequences

### Positive

- 다섯 우회 중 1·2·4 완전히 사라짐. 3 은 widget 자체는 채팅용으로 잔존하지만 ingest 는 안 씀. 5 는 banner accept 의 단일 transact 안에 흡수 (PM dispatch + Y.Map 쓰기 atomic).
- 빈 페이지에 가짜 텍스트 seed 사라짐. `wiki:custom-*` 가 진짜로 빈 상태로 시작 가능.
- ProseMirror 트리에 임의 마지막 단어를 점선으로 표시하는 시각적 충돌 없어짐.
- proposal content 를 multi-block markdown 으로 받을 때 PM 노드 변환이 accept 시점에만 일어남 — 페이지 진입마다 ghost widget 재렌더 비용 0.
- 검토 UI 가 페이지 내부에 명시적으로 박힘 — "이 페이지에 N 건 검토 대기 중" 이 사이드바와 페이지 둘 다에서 보임.

### Negative

- Cursor 식 inline ghost preview 가 사라짐. 사용자가 "이게 페이지 어느 위치에 들어갈지" 미리 못 봄. trade-off: append 위치는 항상 페이지 끝이라 미리 보기의 필요성은 낮음.
- banner 의 markdown preview 는 raw text (whitespace-preserving `<pre>`). heading / bullet 이 rendered 되지 않음. 후속 작업으로 markdown 렌더링 추가 가능.
- 마이그레이션 의존성 — 새 banner 가 마운트되는 페이지 첫 진입까지 옛 마크가 시각적으로 남음. 사용자 입장에선 "한 번 뜨고 사라짐" 으로 보임. 큰 부담 아님.

### Trade-offs / 의식적 보존

- markDecoPlugin 의 INSERT ghost widget 자체는 채팅 propose_change 가 같은 mark surface 를 쓰므로 보존. wiki ingest 가 더 이상 마크를 만들지 않으므로 위키 페이지에서는 widget 렌더 안 됨 — 실제로 우회가 사라진 것과 동일한 효과.
- `IngestProposalCard` 사이드바 카드도 보존. 페이지 밖에 있을 때 "어딘가 검토 대기 중" 신호로 가치 있음.

## Files

**새 파일**
- `apps/writer-tauri/src/layout/WikiPageBanner.tsx` — in-page inbox 컴포넌트
- `apps/writer-tauri/src/hooks/useApplyPendingLogs.ts` — wiki:log 전용 drainer (옛 useApplyPendingMarks 의 log 분기)
- `apps/writer-tauri/src/hooks/useMigrateLegacyIngestMarks.ts` — 옛 ingest mark 일괄 정리

**수정**
- `apps/writer-tauri/src/App.tsx` — banner 마운트 + 새 훅 두 개 연결
- `apps/writer-tauri/src/agent/applyIngest.ts` — 마크 관련 코드 전부 삭제, `applyPendingLogsForView` 만 잔존

**삭제**
- `apps/writer-tauri/src/hooks/useApplyPendingMarks.ts`

**무변경 (의식적)**
- `apps/writer-tauri/src/editor/markDecoPlugin.ts` — 채팅 propose_change(insert) 가 같은 surface 사용
- `apps/writer-tauri/src/editor/proofMarkSchemas.ts` — 스키마 자체는 채팅·댓글·승인 등 다른 흐름에서 그대로 사용
- `apps/writer-tauri/src/editor/markActions.ts` — accept/reject 의 INSERT 분기는 채팅에서 사용
- `apps/writer-tauri/src/agent/ingest.ts` — LLM 호출 + JSON 파싱은 변경 없음
- `apps/writer-tauri/src/state/ingestStore.ts` — 큐 인터페이스 변경 없음
- `apps/writer-tauri/src/hooks/useIdleTrigger.ts` — trigger 흐름 변경 없음
- `apps/writer-tauri/src/layout/IngestProposalCard.tsx` — 사이드바 알림 카드 보존

---

## 한 줄

**wiki ingest 의 검토 surface 만 proofSuggestion 마크에서 in-page banner 로 이전 — 다섯 우회 (last word anchor, empty page seed, ghost widget multi-block, cross-doc lazy stamp, dual writes) 가 정리되고 proof-sdk 마크 시스템은 본래 용도 (인라인 제안/댓글) 로 순수화.**
