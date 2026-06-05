# CM Live Preview — 구문별 구현이 "CM 정석"인가 (구조 검토)

질문: "각 스타일 별 구현법이 정석적으로 된 건지, 구조적으로 잘못된 게 있는지."
방법: 우리 `src/prototypes/livePreview.ts`를 CM6 마크다운 라이브프리뷰의 정석
레퍼런스인 **Ixora**(retronav/ixora)의 per-construct 플러그인과 1:1 대조.

레퍼런스로 읽은 Ixora 소스(원본 gh api):
- `util.ts` — `isCursorInRange(state,[from,to])` = 선택영역이 범위와 **inclusive
  겹침**(`r1[0]<=r2[1] && r2[0]<=r1[1]`), `iterateTreeInVisibleRanges`,
  `invisibleDecoration = Decoration.replace({})`.
- `plugins/hide-mark.ts` — 인라인 마크 숨김.
- `plugins/heading.ts` — 헤딩 + HeaderMark 숨김.
- `plugins/list.ts` — ListBulletPlugin + TaskListsPlugin.

---

## 1. 결론 한 줄

우리의 **reveal 판정식(`editing`)과 블록/인라인 분리 방식은 이미 Ixora와 동일한
정석**이다. 구조적으로 틀린 곳은 없다. 비정석은 **리스트 불릿의 "completeness
(hasSpace) 게이트" 단 한 군데**이고, 부차적으로 **태스크 체크박스가 클릭 토글이
안 되는 기능 누락** 한 군데뿐이다.

---

## 2. 구문별 판정표

| 구문 | 우리 구현 (`livePreview.ts`) | 정석 (Ixora) | 판정 |
|---|---|---|---|
| **헤딩** ATXHeading1‑6 | line `cm-h{n}` + HeaderMark을 `!spansActiveLine`일 때 숨김 (줄 단위) + 뒤 공백 1칸 흡수 | `headingDecorationsPlugin`(줄 크기) + `HideHeaderMarkPlugin`: 커서가 **헤딩 줄**과 겹치면 skip, 아니면 HeaderMark `to+1`까지 replace | ✅ 정석. 블록=줄단위 reveal, 공백 흡수까지 동일 |
| **굵게/기울임/취소선** Strong/Emphasis/Strikethrough(+Mark) | construct에 mark 클래스 + `!editing(부모 범위)`면 EmphasisMark/StrikethroughMark 숨김 | `hide-mark.ts`: `!isCursorInRange(construct)`면 자식 mark들 숨김 | ✅ 정석. construct‑range reveal 동일 |
| **인라인 코드** InlineCode/CodeMark | 위와 동일 패턴 | `hide-mark.ts`에 InlineCode 포함 | ✅ 정석 |
| **링크** Link/LinkMark/URL | mark `cm-link` + `!editing(부모)`면 LinkMark/URL 숨김 | `link.ts`(construct‑range 숨김 동일) | ✅ 정석 |
| **순서 리스트 번호** OrderedList의 ListMark | mark `cm-list-num`, 텍스트 유지(안 숨김) | 번호 raw 유지 + 스타일 | ✅ 정석 |
| **불릿 리스트** BulletList의 ListMark | **`hasSpace`(완성도) 게이트 AND `!editing(dash)`** 둘 다 만족해야 위젯 | `if(isCursorInRange([from,to])) return; ListMark을 위젯으로 replace` — **완성도 게이트 없음** | ⚠️ **비정석**. 게이트가 잉여 패치 |
| **태스크 체크박스** Task/TaskMarker | (수정 전) `CheckboxWidget(checked)` — disabled. reveal 영역이 **`task.to`(항목 전체)** → 본문 글자에 커서만 가도 raw로 풀림 | `TaskListsPlugin`: **클릭 가능** 체크박스(click→`dispatch` 토글). reveal 영역 = **마커**(`!isCursorInRange(marker)`) | ⚠️→✅ **수정 완료**(§6): reveal 영역을 `- [ ]` prefix로 좁히고 클릭 토글 추가 |
| **인용구** Blockquote/QuoteMark | line 클래스 + `!spansActiveLine`면 QuoteMark 숨김 | `blockquote.ts`(줄단위) | ✅ 정석 |
| **구분선** HorizontalRule | `!spansActiveLine`면 line `cm-hr` | 줄단위 | ✅ 정석 (블록위젯 대신 line 보더 = 합리적 회피) |
| **펜스 코드** FencedCode | line `cm-code-block`(mermaid는 skip) | `code-block.ts` | ✅ 정석 (스타일만; 신택스 하이라이팅은 별개 과제) |
| **표** GFM Table | `!spansActiveLine`면 block replace `<table>` 위젯 | (Ixora엔 표 라이브프리뷰 없음) | ✅ 합리적. **block 위젯이라 StateField 필수** — 아래 §3 참고 |
| **이미지** Image | `!editing`이면 `<img>`로 replace, descend 안 함 | `image.ts` 플러그인 + `state/` StateField(블록) | ✅ 정석 |
| **위키링크** `[[제목]]` | 정규식 오버레이 + `!editing`이면 `[[` `]]` 숨김 | (앱 고유, Lezer 문법 밖) | ✅ 정석에 준함 (커스텀 파서는 과함, 정규식이 맞음) |

핵심: **reveal 판정식 자체가 정석.** 우리 `editing()`(inclusive 겹침)은
Ixora `isCursorInRange()`와 **수식까지 동일**하다. 그리고 "블록은 줄단위 reveal,
인라인은 construct‑range reveal"이라는 **분리 기준도 Ixora와 같다**(Ixora 헤딩도
`lineBlockAt`로 줄단위 겹침을 본다).

---

## 3. 아키텍처(구조) 비교 — "구조가 잘못된 건 아니다"

| 축 | 우리 | Ixora |
|---|---|---|
| 데코 보유 | **단일 `StateField` + 거대 switch**, 문서 전체 scan | **construct마다 ViewPlugin** 분리 + 블록(image/table류)만 `state/` StateField |
| scan 범위 | whole‑doc | `visibleRanges`만 |
| reveal util | 인라인 `editing(parent)`, 블록 `spansActiveLine` (한 파일에 섞임) | `util.isCursorInRange`/`checkRangeOverlap` 공용 |

판단:
- **(a) 모놀리식 switch vs per‑construct 모듈** — 기능적 차이 없음. Ixora가
  파일을 쪼갠 건 "라이브러리"라서다(재사용·트리셰이킹). 우리는 스파이크라 한
  파일이 오히려 읽기 쉽다. **틀린 게 아니라 다른 선택.**
- **(b) whole‑doc vs visibleRanges** — 작은 노트에선 무의미. 대형 문서에선
  Ixora가 유리(가시영역만 계산). 프로덕션화 시점의 최적화 항목이지 정석/비정석
  문제가 아니다.
- **(c) 우리가 StateField를 쓴 이유는 정당** — GFM 표가 **block decoration**이고,
  CM6는 block deco를 **StateField에서만** 받는다. 그래서 전부 한 필드에 합쳤다.
  Ixora도 블록(이미지)은 StateField로 뺀다 — 같은 제약, 같은 해법.

→ "리스트가 정석적이지 않게 느껴진" 진짜 원인은 **아키텍처가 아니라 §2의
completeness 게이트 패치**다.

---

## 4. 비정석 지점의 근본 원인 — 리스트 불릿

현재(`livePreview.ts:201‑203`):
```ts
if (sliceOf(nt, nt + 1) !== ' ') return  // 완성도 게이트(잉여)
if (editing(state, nf, nt)) return       // 커서가 마커 위 → raw
widget(nf, nt + 1, BulletWidget)
```

Ixora(정석):
```ts
if (isCursorInRange(view.state, [from, to])) return  // 이것만
replace ListMark with widget
```

왜 게이트가 잉여인가 (Lezer + inclusive 겹침이 이미 처리):
- `-`만 입력(공백 전): CommonMark에서 `-`<EOL>은 **빈 리스트 항목** → Lezer가
  ListMark을 만든다. 이때 커서는 마커 끝(`to`)에 있다 → `editing(nf,nt)`가
  inclusive라 `nf<=커서 && 커서<=nt` 참 → **raw로 노출(불릿 안 생김)**.
  즉 "공백 없으면 불릿" 증상은 게이트 없이 inclusive 판정만으로 이미 막힌다.
- `-x`(공백 없이 글자): Lezer가 리스트로 파싱조차 안 함 → ListMark 없음 → 불릿
  없음. 자동 처리.
- `- `(공백 입력 후): 커서가 공백 뒤(마커 밖) → `editing` 거짓 → 불릿 렌더.
  이게 옵시디언 동작과 정확히 같다. 우리도 이미 동일.

게이트가 실제로 바꾸는 유일한 경우: "다른 줄에 커서가 있을 때 외톨이 `-`."
- 우리(게이트 有): 불릿 안 그림.
- Ixora(게이트 無): 빈 리스트 항목이므로 **불릿을 그림** — CommonMark상 더 정확.

→ **게이트를 빼는 게 더 정석이고 더 단순**하다. 테스트의 "bare `-` → no bullet"
(`livePreview.test.ts:71`)도 커서가 마커 위(pos 1)라 inclusive 판정만으로 그대로
통과한다(검증 필요).

---

## 5. 권고 (작은 정석화 → 큰 구조화 순)

1. **[완료]** 리스트 불릿의 `hasSpace` 완성도 게이트 제거 →
   `if (editing(nf, nt)) return; widget(...)`(= Ixora `isCursorInRange`).
2. **[완료]** 태스크 체크박스: reveal 영역을 `- [ ]` prefix로 좁히고
   **클릭 토글**(`click→view.dispatch`) 추가.
3. **[큰 구조화, 선택·후순위]** per‑construct ViewPlugin 분리 + 블록만 StateField.
   라이브러리화/대형 문서 최적화가 필요한 **전환 GO 이후 프로덕션화 시점**의 작업.
   스파이크 단계에선 불필요.

## 6. 적용 결과 (1·2번)

리스트 3종 모두 정석화 완료. 구조 변경 없이 `livePreview.ts`/`widgets.ts`만 수정.

- **불릿**(`livePreview.ts`): completeness 게이트 제거. 이제 `editing(dash)` 하나로
  판정 — 커서가 마커에 닿을 때만 raw, 그 외엔 불릿. Lezer가 `-`<EOL>/`- `에만
  ListMark을 만들고 inclusive 겹침이 갓 친 `-`를 raw로 잡으므로 별도 검사 불필요.
- **번호**: 변경 없음(원래 정석 — 번호는 항상 표시).
- **체크박스**(`widgets.ts` + `livePreview.ts`):
  - reveal 영역을 `Task` 노드 전체 → `- [ ]` prefix(`[dash.from, TaskMarker.to]`)로
    축소. 본문 텍스트 편집 중에도 체크박스 유지(옵시디언 동작).
  - `CheckboxWidget`에 `pos`(괄호 사이 상태문자 오프셋) 추가, `disabled` 제거,
    `click→view.dispatch({changes})`로 `[ ]`↔`[x]` 토글.

검증: `livePreview.test.ts`에 불릿(caret‑on‑marker 판정) + 체크박스(prefix 영역)
케이스 추가. 전체 스위트 **370 passed (40 files)**, `tsc --noEmit` clean.
