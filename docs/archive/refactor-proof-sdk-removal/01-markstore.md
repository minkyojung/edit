# Phase 1 — markStore in-memory 구현

**기간**: 1.5주
**선행**: Phase 0 산출물 머지 완료
**목적**: Phase 0 에서 정의한 `MarkStore` 인터페이스의 실제 구현. proof-server 우회 — 직접 Y.Doc + PM transaction 으로 mutation.

이 phase 끝나도 기존 호출자 (`markActions`, `applyProposal`, `MarkToolbar`, `WikiPageBanner`) 는 **여전히 proof-server** 를 호출함. 새 markStore 는 별도 sandbox 에서만 검증.

## 산출물

| 산출물 | 위치 |
|---|---|
| markStore 구현 | `apps/writer-tauri/src/domain/markStore.ts` (Phase 0 의 stub 자리 구현으로 채움) |
| Sandbox 페이지 | `apps/writer-tauri/src/dev/MarkStoreSandbox.tsx` (개발 전용, prod 빌드 제외) |
| 단위 테스트 | `apps/writer-tauri/src/domain/__tests__/markStore.test.ts` |

## 구현 세부

### 1. add — 마크 생성

**입력**: `slug`, `kind`, `quote`, `content`/`text`, `by`, ...

**흐름**:
1. quote 검증 (빈 문자열 거부)
2. `getEditorView(slug)` 로 해당 doc 의 EditorView 가져옴
3. `findQuoteInDoc(view, quote)` — PM doc 에서 quote 텍스트 위치 검색
   - 못 찾으면 `{ ok: false, reason: 'anchor_not_found' }` 반환
   - 여러 군데 발견 → 첫 번째 (또는 selection 기준 가장 가까운 곳)
4. `Y.createRelativePositionFromTypeIndex` 로 `startRel` / `endRel` 생성
5. mark id 생성 (`crypto.randomUUID()`)
6. PM transaction:
   - `tr.addMark(from, to, schema.marks.proofSuggestion.create({ id, kind, by, ... }))`
   - origin: `'mark-action'`
7. Y.Map 쓰기:
   - `ydoc.transact(() => { marksMap.set(id, mark) }, 'mark-action')`
8. `{ ok: true, markId: id }` 반환

**핵심 코드 패턴**:
```ts
async add(args) {
  const { view, ydoc } = getHandleForSlug(args.slug)
  if (!view) return { ok: false, reason: 'view_not_ready' }

  const anchor = findQuoteInDoc(view, args.quote)
  if (!anchor) return { ok: false, reason: 'anchor_not_found' }

  const id = crypto.randomUUID()
  const mark: Mark = {
    id,
    kind: args.kind,
    suggestionType: args.suggestionType,
    quote: args.quote,
    startRel: encodeRel(view, ydoc, anchor.from),
    endRel: encodeRel(view, ydoc, anchor.to),
    content: args.content,
    text: args.text,
    status: 'pending',
    by: args.by,
    createdAt: new Date().toISOString(),
    sourceSlug: args.sourceSlug,
    sourceLabel: args.sourceLabel,
    model: args.model,
  }

  ydoc.transact(() => {
    ydoc.getMap<Mark>('marks').set(id, mark)
  }, 'mark-action')

  view.dispatch(
    view.state.tr
      .addMark(
        anchor.from,
        anchor.to,
        schema.marks[markKindToSchemaName(args.kind)].create(mark),
      )
      .setMeta('mark-action', { kind: 'add', id }),
  )

  return { ok: true, markId: id }
}
```

**왜 PM transaction + Y.Map 쓰기 둘 다**: PM mark 는 본문에 시각적으로 보이는 표시 (밑줄 등). Y.Map 은 메타 (id, status, content 등). 둘 다 있어야 hover / accept 흐름이 동작. 둘을 묶어서 한 origin 으로 보내야 UndoManager 가 atomic 으로 처리 (참조: `MilkdownEditor.tsx:294~342`).

### 2. accept — 마크 수락

**입력**: `slug`, `markId`, `by`

**흐름**:
1. `marksMap.get(markId)` 으로 mark 조회. 없으면 false.
2. PM doc 에서 anchor 검색: `findInlineAnchor(view, markId, 'proofSuggestion')` (기존 markActions.ts:37~55 함수 재사용)
3. **Drift 검증**: anchor 위치의 현재 텍스트 vs `mark.quote` 비교
   - 다르면: `mark.status = 'stale'` 로 업데이트, false 반환 + 'stale' 알림
4. suggestion 처리 (suggestionType 별로):
   - `insert`: anchor 위치에 `mark.content` 삽입
   - `delete`: anchor 범위 텍스트 제거
   - `replace`: anchor 범위 텍스트를 `mark.content` 로 교체
5. PM mark 제거 (suggestion 마크는 accept 후 사라짐)
6. Y.Map 업데이트: `mark.status = 'accepted'`, `mark.acceptedAt = now`
7. authored mark 스탬프: 변경된 텍스트 범위에 `proofAuthored` 마크 추가 (출처 breadcrumb)
8. true 반환

**Comment 처리**: comment 는 accept = resolve 와 동의어. 단순히 `status = 'accepted'` 로 변경. PM 마크는 유지 (resolved 상태 시각화).

### 3. reject — 마크 거절

**입력**: `slug`, `markId`, `by`

**흐름**:
1. PM mark 제거 (`tr.removeMark`)
2. Y.Map 엔트리 제거 (`marksMap.delete(markId)`)

수락보다 단순. drift 검증 불필요 — 어차피 본문은 안 건드림.

### 4. get / list / subscribe

- `get`: `marksMap.get(markId)` 직접 반환
- `list`: `Array.from(marksMap.values())` + status 필터
- `subscribe`: `marksMap.observe()` wrapper. listener 가 `marks: Mark[]` 받음.

`list` 호출 시 각 마크의 drift 상태도 옵션으로 확인 (`opts.includeStale: true` 일 때 stale 자동 마킹).

## 핵심 헬퍼

### findQuoteInDoc(view, quote): { from, to } | null
PM doc 의 텍스트에서 quote 부분문자열 검색. `view.state.doc.textBetween(...)` 로 전체 텍스트 추출 후 indexOf. 첫 매치 반환. 여러 발견 시 첫 번째.

### encodeRel / decodeRel
Y.RelativePosition → base64 string ↔ Y.RelativePosition. proof-sdk 가 쓰던 방식과 동일 — Phase 0 의 마크 모델에 `startRel: string` 으로 저장.

### getHandleForSlug(slug): { view, ydoc, handle } | null
`useDocsStore.getState().handles.get(slug)` 로 핸들 가져오기. EditorView 는 `useEditorViewStore` 에서.

## 단위 테스트

`apps/writer-tauri/src/domain/__tests__/markStore.test.ts`:

1. **add — 정상 케이스**: quote 가 doc 에 있음 → 마크 추가됨, PM 마크 + Y.Map 모두 있음
2. **add — quote 없음**: `reason: 'anchor_not_found'`
3. **add — view 없음**: `reason: 'view_not_ready'`
4. **accept — suggestion replace**: quote 자리 content 로 교체, 마크 사라짐
5. **accept — drift 감지**: 사이에 doc 편집 → quote 불일치 → false + status='stale'
6. **accept — comment**: status='accepted', PM 마크 유지
7. **reject**: 마크 사라짐, doc 안 바뀜
8. **list — status 필터**: pending 만, accepted 만, stale 만
9. **subscribe**: 마크 추가/삭제 시 listener 호출됨, unsubscribe 후 호출 안 됨
10. **Cmd+Z 시뮬레이션**: add → undo → 마크 사라짐 + Y.Map 엔트리도 사라짐 (UndoManager 트래킹 확인)

## Sandbox 페이지

`apps/writer-tauri/src/dev/MarkStoreSandbox.tsx`:
- 작은 doc 1개 + EditorView 마운트
- 버튼: "Add suggestion", "Add comment", "List marks", "Reject all"
- 텍스트 영역에 입력하면 markStore 의 모든 동작을 GUI 로 시연
- prod 빌드 제외 (`if (import.meta.env.DEV) ...` 같이 lazy import)

목적: 단위 테스트 외에 실제 PM/Yjs 위에서 만족스럽게 동작하는지 사람이 확인.

## 완료 기준

- [ ] `markStore` 5개 메서드 모두 구현 + 컴파일 통과
- [ ] 단위 테스트 10개 통과
- [ ] Sandbox 페이지에서 add → accept (replace) → 본문 바뀜 + 마크 사라짐 동작 확인
- [ ] Sandbox 페이지에서 add → reject → 마크 사라짐, 본문 그대로 동작 확인
- [ ] Sandbox 에서 Cmd+Z 한 단계로 accept 복원 동작 확인
- [ ] Sandbox 에서 drift 시나리오: add → 본문 편집 → accept → "stale" 처리 확인

## 다음 단계
Phase 2 — 기존 호출자 (`applyProposal`, `markActions`, `MarkToolbar`, `WikiPageBanner`) 가 markStore 를 통과하도록 갈아끼우기.

## 위험

| 위험 | 완충 |
|---|---|
| PM mark 와 Y.Map 의 atomic 보장 깨짐 → undo 불일치 | UndoManager origin 트래킹 확인 (`MilkdownEditor.tsx:294~342` 의 `trackedOrigins`). origin 이름은 기존 'mark-action' 그대로 사용 |
| findQuoteInDoc 의 첫 매치 정책이 부정확 | EditorView selection 우선 + selection 안에서 quote 검색 → fallback 으로 전체 doc. selection 기반이 자연스럽고 정확 |
| Y.RelativePosition encode/decode 의 binary 호환성 | proof-sdk 가 쓰던 방식과 동일 — `Y.createRelativePositionFromTypeIndex` → `Y.encodeRelativePosition` → base64. 기존 데이터와 호환 |
| Sandbox 가 production 빌드에 섞임 | `import.meta.env.DEV` 가드 + 라우트 분리. vite tree-shake 검증 |
