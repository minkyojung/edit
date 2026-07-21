# 이주 — 하이라이트(형광펜+메모) CM 재설계 분석

> read-it-later(저장한 글 읽기)용 하이라이트. "동작 정의 → CM 정공법 → 공짜/커스텀".
> 결론: CM과 궁합이 매우 좋다 — 하이라이트가 **본문을 안 건드리는 순수 데코 오버레이**가
> 되고, 재앵커가 offset 검색이라 PM의 트리 탐색보다 단순하며, 구조가 우리가 이미 증명한
> AI-앵커 작업과 동형. 2026-06-05.
> 근거: `editor/useHighlightMarks.ts`, `highlightClickPlugin.ts`,
> `HighlightNoteField.tsx`, `schema/proof-marks.ts`(proofHighlight),
> `anchorSearch.ts`(findHighlightRange/occurrenceIndexAt), `.meta.json` records.

## 1. 원하는 동작 (현재 PM 코드에서 떠냄)

| # | 동작 |
|---|---|
| 진실 | **레코드가 source of truth**: `{ id, quote, note, occurrence }` — KnownDoc/`.meta.json`에 저장. **본문 마크다운엔 안 들어감**(body 깨끗 유지) |
| 렌더 | 각 레코드를 라이브 본문에 **재앵커**(quote + occurrence 인덱스) → 그 범위에 형광펜 |
| 시점 | 마운트 시(저장글 다시 열면 칠해짐) + 레코드 변경 시(생성/삭제/메모) |
| 생성 | 텍스트 선택 → "하이라이트" → 레코드 추가(quote=선택텍스트, occurrence=몇 번째) |
| 삭제 | 레코드 제거(마크는 따라감) |
| 메모 | 하이라이트에 메모 편집(HighlightNoteField) |
| 클릭 | 하이라이트 클릭 → 그 범위 선택 → 메뉴(메모/삭제) 표시 |

## 2. CM 정공법 — 순수 데코 오버레이 + offset 앵커

핵심: 하이라이트는 **doc 텍스트를 절대 안 건드림.** 외부 레코드로부터 매번 데코를 만든다.

| 원하는 동작 | CM 메커니즘 |
|---|---|
| 렌더(형광펜) | `Decoration.mark({ class:'cm-highlight', attributes:{'data-hl-id':id} })` |
| 데코 제공 | 레코드 보유 StateField → `EditorView.decorations.from(f)` (인라인 마크라 ViewPlugin도 가능) |
| 재앵커(quote+occurrence) | **offset 검색** — 문자열에서 quote의 n번째 위치(아래). PM의 트리워크 `findHighlightRange` 불필요 |
| 편집 중 위치유지 | (편집 가능 글이면) `ChangeSet`가 데코 자동 매핑. 저장글은 사실상 불변이라 재앵커만으로 충분 |
| 클릭 → 선택/메모 | `domEventHandlers` 또는 pos→레코드 매칭 (위키링크/링크 클릭과 동형) |
| 메모 팝업 | CM `hoverTooltip`/`showTooltip` facet에 기존 `HighlightNoteField` React 마운트, 또는 패널 |

재앵커(정석, 단순):
```ts
function rangeFor(text, quote, occurrence) {
  let idx = -1
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(quote, idx + 1)
    if (idx < 0) return null
  }
  return { from: idx, to: idx + quote.length }
}
```

## 3. 공짜 / 커스텀 / PM보다 단순 / 증발 / 재사용

- **CM 공짜**: 마크 데코, (편집 가능 시) ChangeSet 자동 매핑, 툴팁 위치(hoverTooltip).
- **커스텀(작음)**: 레코드→데코 StateField, offset 재앵커, 생성/삭제/메모 명령(레코드 조작),
  클릭 핸들러. 대부분 짧음.
- **PM보다 단순**: ①재앵커가 offset(트리워크 X) ②마크가 **본문 미접촉**이라 PM의
  `addToHistory:false` 트랜잭션 춤·DOM `span[data-highlight]` 왕복이 **전부 불필요**.
- **증발**: `proofHighlightSchema`(PM 스키마 마크), addToHistory 댄스, DOM round-trip.
- **재사용**: 레코드 스토어(`.meta.json`/docsStore.highlights), `HighlightNoteField`
  (React UI), 생성/삭제/메모 레코드 로직, occurrence 계산.

> 핵심: 하이라이트는 구조적으로 **우리가 이미 증명한 AI-앵커(proofSuggestion) 작업과
> 동형의 "앵커된 데코 레이어"**. 새 리스크 없음 — 분량만.

## 4. 생성 시 occurrence 계산 (정석)

선택 시작 offset 앞에 같은 quote가 몇 번 나왔는지 세면 occurrence:
```ts
function occurrenceAt(text, quote, selFrom) {
  let count = 0, idx = text.indexOf(quote)
  while (idx >= 0 && idx < selFrom) { count++; idx = text.indexOf(quote, idx + 1) }
  return count
}
```
(PM `occurrenceIndexAt`의 문자열판 — 더 단순.)

## 5. 검증 (③) — 헤드리스 단위테스트

- `rangeFor`: 첫/n번째 occurrence를 정확히 찾는가, 없으면 null
- `occurrenceAt`: 중복 quote에서 올바른 인덱스
- 레코드 세트 → StateField가 각 레코드를 cm-highlight 데코로 (개수/범위)
- (편집 가능 시) 무관 편집 후 데코가 ChangeSet로 매핑되어 제자리 유지
- 클릭 위치 → 해당 하이라이트 id 매칭

## 6. 작업 순서 / 공수 (감)

1. 레코드 타입 + 데코 StateField(레코드→cm-highlight) + offset 재앵커. 테스트.
2. 생성(선택→레코드) / 삭제 / 메모 명령 (프로토타입은 정적 레코드 + 토스트/콘솔로 증명).
3. 클릭 → 선택/메모 팝업(hoverTooltip + 기존 React note field).
4. cmTheme에 형광펜 스타일.

- 합계 대략 **1.5~2.5일**. 리스크 낮음(AI-앵커와 동형), 코드량 PM 대비 감소.

## 요약
- **CM 공짜/단순**: 데코 오버레이 + offset 재앵커 + 본문 미접촉(history 댄스 증발).
- **커스텀(작음)**: 레코드→데코 필드, 재앵커/occurrence, 생성·삭제·메모, 클릭.
- **재사용**: 레코드 스토어(.meta.json), HighlightNoteField UI.
- 정석 = "하이라이트는 본문 밖 레코드의 view-only 데코" — CM 철학과 정확히 일치.
