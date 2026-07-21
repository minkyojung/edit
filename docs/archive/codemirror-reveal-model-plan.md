# CM 이주 — Live Preview reveal 모델: 줄 단위 → 구문(문자 범위) 단위

> 증상: 마크다운 스타일이 **커서가 그 줄에 있으면 줄 전체의 마커가 다 드러나고**, 스타일도
> 줄을 떠나야(줄바꿈) 적용됨. 옵시디언은 **커서가 그 구문 범위 안에 있을 때만 그 구문만**
> 드러내고, 입력하는 즉시(문자 단위) 적용됨. = 우리는 line-level, 정석은 range-level.
> 2026-06-05. 근거: discuss.codemirror.net "Hide markdown syntax", Ixora, 우리 코드.

## 1. 현재(우리) vs 정석(옵시디언)
| | 우리 (line-level) | 정석 (range-level) |
|---|---|---|
| reveal 단위 | 커서가 있는 **줄 전체**의 모든 마커 노출 | 커서가 들어간 **그 구문(range)만** 노출 |
| 적용 시점 | 줄을 떠나야 스타일 적용 | 입력 중 구문이 완성되고 커서가 빠지면 **즉시** |
| 코드 | `spansActiveLine(node)` (줄 번호 비교) | `selection ∩ node.range` (범위 겹침 비교) |

## 2. 정석 CM 기법 (canonical)
포럼/Ixora 공통 패턴 = **"모든 마커 숨김 데코를 만든 뒤, 현재 선택과 겹치는 것만 제거"**:
```ts
// 1) syntaxTree를 걸어 모든 인라인 마커에 숨김 데코 생성 (줄 조건 없이)
let deco = buildHideMarks(state)              // EmphasisMark/CodeMark/LinkMark…
// 2) 커서/선택과 겹치는 데코만 reveal (제거)
for (const r of state.selection.ranges) {
  deco = deco.update({
    filter: (from, to) => to < r.from || from > r.to,  // 안 겹치면 유지(숨김), 겹치면 제거(노출)
  })
}
```
- **per-construct**: 같은 줄의 다른 `**굵게**`는 그대로 숨겨지고, 커서가 든 구문만 노출.
- **즉시 적용**: 커서가 그 구문 밖으로 나가는 순간(같은 줄이어도) 마커가 다시 숨겨지며 스타일 적용 → "문자 단위" 체감.
- **selection 변경마다 재계산**(이미 우리도 `tr.selection`에 재빌드). reveal이 selection
  의존이므로 커서 이동마다 갱신 필요.

경계(겹침) 규칙 뉘앙스:
- `overlap = from <= r.to && r.from <= to` (양끝 포함)으로 잡으면, 커서가 구문 끝에 딱
  붙어 있을 때도 노출 → 타이핑 직후 자연스러움. 너무 빡빡하면 입력 중 깜빡임. 옵시디언은
  대체로 "구문 내부 또는 인접"에서 노출.

## 3. 블록 vs 인라인 — 정석은 하이브리드
range-level은 **인라인 마크**에 적용. 블록은 규칙이 다름:
| 구문 | reveal 규칙 |
|---|---|
| 굵게/기울임/인라인코드/취소선/링크/위키링크 | **range-level** (커서가 그 구문 안일 때만) ← 이번 핵심 |
| 헤딩 `#` | 커서가 **그 헤딩(줄/텍스트) 안**일 때 노출, 헤딩 크기는 항상 유지 |
| 리스트 불릿 `-` | **절대 raw로 안 바꿈**(항상 `•`) — 이전 진단의 그 문제 |
| 인용 `>` / hr `---` | 헤딩과 동일(커서가 그 줄일 때만) |

## 4. atomicRanges 주의
- 숨긴 마커를 `atomicRanges`에 넣으면 커서 이동/삭제 시 통째로 점프·삭제됨. 포럼은
  세밀 제어가 필요하면 **widget 방식**을 권장. 우리는 인라인 마크 숨김을
  `Decoration.replace({})`로 하되, **노출(커서 든 구문)일 땐 데코가 없으므로** 그 구문
  편집은 자연스러움. atomic은 이미지/표/불릿 같은 "통짜 객체"에만 한정.

## 5. 우리 적용 방향 (livePreview.ts)
- **인라인 핸들러의 reveal 판정을 교체**: `spansActiveLine(state, nf, nt, active)` →
  `selectionOverlaps(state, nf, nt)` (구문 범위 겹침). EmphasisMark/CodeMark/LinkMark/URL/
  StrikethroughMark/위키링크 브래킷에 적용.
- **블록은 분리**: 헤딩 `#`·인용 `>`·hr은 줄 기반 유지(또는 헤딩 텍스트 범위 겹침),
  **리스트 불릿은 reveal 제거**(항상 `•`)·체크박스도 항상 유지(이전 진단 #1).
- 꾸미기 mark(cm-strong 등)는 지금처럼 항상 적용(노출 중엔 마커도 보이니 raw처럼 보임).
- IME 동결(방금 추가한 `imeComposition`)과 결합: 조합 중엔 재계산 안 함 → 충돌 없음.

## 6. 검증
- 헤드리스: 커서를 `**bold**` 내부/외부에 두고 `buildDecorations` 결과에서 그 EmphasisMark
  숨김 데코가 **있/없** 토글되는지(범위 단위). 같은 줄의 다른 구문은 영향 없는지.
- 손검증(실 IME 포함): 한 줄에 `**a** _b_` 두고 커서를 a↔b로 옮길 때 **각각만** 노출되는지,
  타이핑 직후 즉시 스타일 적용되는지.

## 7. 효과
이 한 번의 모델 교체로 — (a) "줄 전체가 raw로 보이는" 위화감, (b) "줄바꿈해야 스타일
적용", (c) 리스트/헤딩 편집 중 마커 노출이 **모두 자연스러워짐**. 옵시디언급 "문자 단위
live preview" 달성.

## 8. 출처
- https://discuss.codemirror.net/t/hide-markdown-syntax/7602 (filter-by-selection 정석)
- https://codeberg.org/retronav/ixora (CM6 live-preview 확장팩, cursor-aware reveal)
- https://codemirror.net/docs/ref/ (Decoration/atomicRanges)
