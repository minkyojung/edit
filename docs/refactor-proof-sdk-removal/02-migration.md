# Phase 2 — 호출자 갈아끼우기

**기간**: 1주
**선행**: Phase 1 완료 (markStore 구현 + sandbox 통과)
**목적**: 기존에 `proofClient.ops` 를 호출하던 모든 코드가 `markStore` 의 5개 메서드를 통과하도록 변경. 이 phase 끝나면 proof-server 가 **호출자 0** 상태 (dead code).

이 phase 의 핵심은 **한 호출자씩** 갈아끼우는 것. 한 호출자 변경 후 회귀 테스트 → 다음 호출자. proof-server 와 markStore 가 한동안 공존하지만, 어느 시점에든 시스템은 일관됨.

## 작업 순서 (낮은 위험 → 높은 위험)

| 순서 | 호출자 | 현재 위치 | 위험 |
|---|---|---|---|
| 1 | `markActions.cleanupMark` | `editor/markActions.ts:204` | 낮음 — silent cleanup |
| 2 | `markActions.rejectMark` | `editor/markActions.ts:166` | 낮음 — 단순 제거 |
| 3 | `markActions.acceptMark` | `editor/markActions.ts:112` | 중간 — drift 검증 신규 |
| 4 | `applyProposal` | `agent/applyProposal.ts:47` | 중간 — 호출 빈도 높음 |
| 5 | `MarkToolbar` 의 코멘트/제안 생성 | `layout/MarkToolbar.tsx` | 중간 — 사용자 직접 사용 |
| 6 | `WikiPageBanner` 의 accept | `layout/WikiPageBanner.tsx` | 높음 — ingest 흐름의 최종 단계 |

## 1. markActions.cleanupMark 변경

### 현재 코드 (`markActions.ts:204~220`)
```ts
export async function cleanupMark(slug, ydoc, markId, by = 'ai:unknown') {
  const stored = ydoc?.getMap<StoredMark>('marks').get(markId)
  const op = stored?.kind === 'comment'
    ? { type: 'comment.resolve', markId, by }
    : { type: 'suggestion.reject', markId, by }
  try {
    await proofClient.ops(slug, null, op)
  } catch (err) {
    console.warn('[markActions] cleanup failed', err)
  }
}
```

### 새 코드
```ts
export async function cleanupMark(slug, ydoc, markId, by = 'ai:unknown') {
  const stored = ydoc?.getMap<Mark>('marks').get(markId)
  if (!stored) return
  if (stored.kind === 'comment') {
    await markStore.accept({ slug, markId, by })  // accept = resolve for comments
  } else {
    await markStore.reject({ slug, markId, by })
  }
}
```

### 검증
- `handleRegenerate` 가 이전 run 의 마크 정리할 때 호출됨
- regenerate → 이전 마크 사라짐 + 새 마크 박힘 정상 동작
- 실패 시 silent (warn 만 — 사용자 흐름 막지 않음)

## 2. markActions.rejectMark 변경

### 현재 코드 (`markActions.ts:166~192`)
```ts
export async function rejectMark(slug, view, markId, by = 'human:unknown') {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) { /* ... */ return false }
  try {
    await proofClient.ops(slug, null, { type: 'suggestion.reject', markId, by })
  } catch (err) { /* ... */ return false }
  return true
}
```

### 새 코드
```ts
export async function rejectMark(slug, view, markId, by = 'human:unknown') {
  const ok = await markStore.reject({ slug, markId, by })
  if (!ok) notify.markCantDismiss()
  return ok
}
```

`findInlineAnchor` 검증은 markStore 내부로 이동. view 파라미터 제거 가능 (markStore 가 자기 내부에서 view 가져옴).

### 검증
- 위키 페이지에서 AI 제안 X 버튼 → 마크 사라짐
- Cmd+Z → 마크 복원 (UndoManager origin 'mark-action' 트래킹)

## 3. markActions.acceptMark 변경

### 현재 코드 (`markActions.ts:112~157`)
- proofClient.ops(suggestion.accept) 호출
- 성공 시 `authoredMeta` Y.Map 에 sourceSlug/model/acceptedAt 스탬프

### 새 코드
```ts
export async function acceptMark(slug, view, ydoc, markId, by = 'human:unknown') {
  const ok = await markStore.accept({ slug, markId, by })
  if (!ok) notify.markCantApply()
  return ok
}
```

`authoredMeta` Y.Map 별도 쓰기 부분은 markStore.accept 내부로 이동 (Phase 0 의 통합된 `Mark` 모델에는 `sourceSlug`/`model`/`acceptedAt` 이 이미 포함됨 — `authoredMeta` Y.Map 자체가 폐기 대상).

### 검증
- 위키 페이지에서 AI 제안 ✓ 버튼 → 본문에 적용 + 마크 사라짐
- Hover popover 에 "from daily 2026-05-15, claude-haiku-4.5" 출처 표시 정상
- Cmd+Z → 마크 + 텍스트 복원
- Drift 시나리오: 제안 받은 후 본문 편집 → accept → "stale" 토스트

## 4. applyProposal 변경

### 현재 코드 (`agent/applyProposal.ts:47~78`)
```ts
export async function applyProposal(slug, proposal, meta): Promise<ApplyOutcome> {
  // proof-server /ops 호출, suggestion.add 또는 comment.add
}
```

### 새 코드
```ts
export async function applyProposal(slug, proposal, meta): Promise<ApplyOutcome> {
  const reason = validate(proposal)
  if (reason) return { ok: false, reason }

  const result = await markStore.add({
    slug,
    kind: proposal.kind === 'suggestion' ? 'suggestion' : 'comment',
    suggestionType: proposal.suggestionType,
    quote: proposal.quote,
    content: proposal.content,
    text: proposal.text,
    by: meta.agentId,
  })

  return result
}
```

`validate` 함수 유지. `toOutcome` / `toFailure` 변환은 markStore.add 가 이미 `{ ok, markId } | { ok, reason }` 형태로 반환하므로 불필요.

### 검증
- daily 노트 저장 → ingest 발동 → 위키 페이지에 제안 박힘
- 위키 페이지 banner UI 에서 accept → 정상 적용
- 중복 박힘 없음 (Phase 0 의 schema 좁히기 보존)
- propose_change tool 호출 빈도 확인 — 동작 빈도 변화 없음

## 5. MarkToolbar 변경

### 현재 코드 (`layout/MarkToolbar.tsx`)
106~195줄 부근에서 직접 `Y.Map('marks').set()` + `tr.addMark(...)` 패턴으로 코멘트/제안 마크 생성 (proof-server 우회 — 사용자 트리거).

### 새 코드
```ts
const handleComment = async (text: string) => {
  const result = await markStore.add({
    slug,
    kind: 'comment',
    quote: selectedText,
    text,
    by: `human:${userId}`,
  })
  if (!result.ok) notify.markCantCreate()
  onDismiss()
}

const handleReplace = async (newContent: string) => {
  const result = await markStore.add({
    slug,
    kind: 'suggestion',
    suggestionType: 'replace',
    quote: selectedText,
    content: newContent,
    by: `human:${userId}`,
  })
  if (!result.ok) notify.markCantCreate()
  onDismiss()
}

const handleDelete = async () => { /* same with suggestionType: 'delete' */ }
```

### 검증
- 텍스트 선택 → 툴바 → "Comment" → 입력 → 마크 박힘 + popover 가능
- 텍스트 선택 → 툴바 → "Replace" → 입력 → 마크 박힘 + accept 시 정상 교체
- 텍스트 선택 → 툴바 → "Delete" → 마크 박힘 + accept 시 정상 삭제
- 각 케이스에서 Cmd+Z 한 단계 복원

## 6. WikiPageBanner 변경

### 현재 코드 (`layout/WikiPageBanner.tsx:1~228`)
ingest 결과 카드 UI. accept 버튼 클릭 시 PM 파싱 + proofAuthored mark 스탬프 + 본문 삽입.

### 새 코드
직접 mutation 코드 제거. markStore.accept 호출.
proposal 의 entity + bullets 를 markdown 으로 조립 → `markStore.add(kind: 'suggestion', suggestionType: 'insert', content: assembledMd)` → 그 다음 즉시 `markStore.accept(markId)`.

또는 두 단계가 같은 op 인 패턴이라면, markStore 에 `addAccepted` 같은 편의 메서드 추가 검토. Phase 0 인터페이스에 추가할지 결정 필요.

### 검증
- ingest 큐에 제안 들어옴 → WikiPageBanner 에 카드로 표시
- accept 클릭 → 위키 페이지 본문에 entity 헤딩 + bullets 들어감
- 본문 영역에 proofAuthored 마크 부착 (hover → 출처 표시)
- reject 클릭 → 카드 사라지고 본문 변화 없음

## 회귀 테스트 (각 호출자 변경 후 매번)

각 호출자를 markStore 로 갈아끼운 직후 다음 체크리스트:

1. ✓ daily 작성 → 자동 ingest → 위키 페이지 banner 카드 표시
2. ✓ banner 에서 accept → 위키 페이지에 entity + bullets 들어감
3. ✓ banner 에서 reject → 카드 사라짐
4. ✓ 위키 페이지 본문 hover → 출처 popover ("from daily 2026-05-15, claude-haiku-4.5")
5. ✓ 텍스트 선택 → 툴바 → comment/replace/delete 모두 동작
6. ✓ 코멘트 hover → popover 표시 + 텍스트 확인
7. ✓ Cmd+Z 한 번에 accept/comment 복원
8. ✓ 위키 페이지 본문 편집 후 (drift 유발) accept → "stale" 처리 정상
9. ✓ regenerate 시 이전 마크들 정리됨

## proof-server 호출 0 확인

마지막 호출자까지 변경 완료 후:

```bash
# 1. proof-server stdout 로그에 /ops POST 가 안 찍히는지 확인
#    (5분간 위 회귀 시나리오 다 돌려보고)
# 2. 코드 grep:
```

```
Grep "proofClient.ops" → 0건 (또는 dead code 만 남음)
```

이게 통과되면 Phase 3 (제거) 가능.

## 완료 기준

- [ ] 6개 호출자 모두 markStore 경유
- [ ] 위 회귀 테스트 9개 통과
- [ ] `proofClient.ops` 호출 0건 (proof-server log + grep)
- [ ] 단, proof-server 는 여전히 spawn 됨 (Phase 3 에서 제거)
- [ ] Cmd+Z atomic 보장 깨진 케이스 없음

## 다음 단계
Phase 3 — proof-server 사이드카 + `@proof-sdk/*` 의존 + 관련 파일들 제거.

## 위험

| 위험 | 완충 |
|---|---|
| Phase 1 단위 테스트가 통과해도 실제 ingest 흐름에서 미묘한 차이 | 호출자 1개씩 갈아끼우고 매번 회귀 테스트. 한 호출자 변경 후 다음 호출자 시작 전 사용자 승인 |
| applyProposal 의 reason 코드와 markStore.add 의 reason 코드 mismatch | reason 코드 enum 을 Phase 0 markStore 인터페이스에 명시. chat.ts 의 propose_change tool result 로직 동기화 |
| WikiPageBanner 의 PM 파싱 로직이 ingest 의 entity+bullets 구조와 결합돼 있음 | banner accept 흐름을 별도 함수 `applyIngestProposal()` 로 추출. markStore.add 외에 wiki page 생성 로직도 같이 정리 |
| UndoManager origin 트래킹이 markStore 경유 후에도 동작 | MilkdownEditor.tsx:328 의 `trackedOrigins: ['mark-action', ...]` 확인. markStore 가 'mark-action' origin 그대로 사용 |
