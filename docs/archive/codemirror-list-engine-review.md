# CM 라이브프리뷰 엔진 — 엔지니어 리뷰 (리스트/캐럿 버그 군 + 리팩토링)

목적: 산발적 버그(스페이스 시 캐럿 좌측 이동, 중첩 리스트 마커 겹침 등)를 하나씩
잡는 대신, **원인이 되는 구조를 파악해 리팩토링 방향을 정한다.** 2026-06-06.
대상: `apps/writer-tauri/src/prototypes/livePreview.ts`(엔진) + `widgets.ts` +
`cmTheme.ts` + `CodeMirrorPreview.tsx`(호스트) + `imeComposition.ts`.

## 결론 한 줄

두 버그는 **모놀리식 단일 StateField + 거대 switch** 구조가 만드는 4개 버그 군의
증상이다. 타깃 패치 2개로 보이는 증상은 잡히지만, **per-construct 플러그인 + 공유
reveal 술어 + ViewPlugin(visibleRanges)** 로의 단계적 리팩토링이 근본 해결이다.
단, 이미 정석으로 만든 것(`::before` 불릿, `coordsAt` 캐럿, atomicRanges, IME
freeze, 마커별 슬롯)은 **반드시 보존**한다(Ixora의 더 단순·열등한 버전으로 회귀 금지).

---

## 1. 보고된 버그 2개 — 근본 원인

### R1. 스페이스를 누르면 가끔 캐럿이 좌측으로 (P0)
`livePreview.ts:138-143, 280-285, 383`
- `-`+space로 줄이 리스트가 되는 순간, **같은 프레임**에 ① `caretIn` reveal이 off로
  뒤집히고 ② `hide(nf, nt+trailing)`가 `- `를 **atomic** replace로 추가하고 ③
  `lpField`가 `tr.docChanged`로 즉시 재계산된다.
- 캐럿이 방금 atomic이 된 영역의 경계에 앉아, CM `skipAtomicRanges`의 경계 tie-break
  (keymap/DOM-input/IME 경로마다 다름)가 캐럿을 `from`(좌측)으로 스냅 → "가끔" 좌측 이동.
- **핵심 결함**: 위젯이 아닌 단순 hide(특히 `::before`로 그리는 불릿의 `- `)까지
  atomic에 넣는다. atomic은 **캐럿 이동만** 막으면 되고, 진짜 필요한 건 DOM 타일
  위젯(체크박스/숫자/이미지/표)뿐이다.

### R2. 리스트 안에 리스트를 만들면 마커가 겹침/어긋남 (P0)
`livePreview.ts:236-285`, `cmTheme.ts:124-151`
- 들여쓰기를 **두 시스템이 우연히 일치**해야 맞는 구조: 소스 선행공백을
  `hide(ln.from, nf)`로 지우고, CSS가 `listLevel()*1.6em`로 다시 만든다. 둘을 묶는
  불변식이 없다.
- `listLevel`이 loose 리스트/lazy continuation 경계에서 한 단계 어긋나거나, 시각
  스텝(1.6em)과 실제 `indentUnit`(2칸) 폭이 달라, **소스 들여쓰기는 지웠는데 CSS
  들여쓰기가 안 맞으면** 중첩 마커가 부모 칸으로 가서 겹친다.
- 게다가 `listLine`은 **ListMark가 있는 첫 줄에만** 붙는다. 항목의 연속 줄(마커 없는
  줄)은 데코를 못 받아 들여쓰기가 0으로 떨어진다.

---

## 2. 버그 군(群) 요약 — 리팩토링 판단 근거

1. **숨긴 소스에 atomic 남발 (R1, L4, L5, L11)** — 위젯 replace만 atomic이면 되는데
   모든 hide를 atomic으로. 캐럿 스냅 표면을 reveal flip과 같은 프레임에 만든다.
2. **들여쓰기 이원화 (R2, L1, L8, L11)** — 소스 제거 + CSS 재합성이 불변식 없이
   우연히 일치. 첫 줄에만 데코, level이 경계에서 드리프트.
3. **reveal 술어 3종 (L1, L2, L6)** — `spansActiveLine`(블록)/`editing`(인라인,
   한 단계)/`caretIn`(리스트, 접힌 커서). 다중 커서·범위 선택·중첩에서 불일치.
4. **문법 밖 정규식 오버레이 (L9)** — 위키링크가 트리를 우회 → 코드스팬/기존 hide와
   겹치는 replace 생성 가능.
5. **무증분 (L7)** — 선택 변경마다 전체 문서 재스캔, 캐시 무한 증가(스파이크엔 OK).

---

## 3. 잠재 버그 — 우선순위표 (요약)

| # | 심각도 | 위치 | 증상 / 원인 |
|---|---|---|---|
| R1 | P0 | livePreview.ts:138-143,280-285 | 스페이스 시 캐럿 좌측 — atomic+reveal flip 동시 |
| R2 | P0 | livePreview.ts:236-285 | 중첩 마커 겹침 — 소스/CSS 들여쓰기 불일치, 첫 줄만 데코 |
| L1 | P1 | livePreview.ts:165-169 | reveal 모델 불일치(블록/인라인/리스트 제각각) |
| L2 | P1 | livePreview.ts:166-169 | `***bold italic***` 등 중첩 마크 한 단계만 reveal |
| L3 | P1 | livePreview.ts:179,225,283,301 | `nt+1` 미클램프 → 줄 끝 마커가 개행 삼킴 가능 |
| L4 | P1 | livePreview.ts:251,303 | 같은 줄 hide+widget+line 데코 인접 — 정렬 의존 취약 |
| L5 | P1 | livePreview.ts:294 | `cm-task-checked` mark가 체크박스 replace 영역과 겹침 |
| L6 | P1 | imeComposition + livePreview.ts:382 | 조합 중 stale atomic(미매핑) → 캐럿 스킵 오작동 |
| L7 | P2 | livePreview.ts:366-383 | 선택마다 전체 재스캔, 캐시 무한 |
| L8 | P2 | widgets.ts caretAtContentColumn | 레이아웃 전 `.cm-line` null → 폴백, RTL 미지원 |
| L9 | P2 | livePreview.ts:339-353 | 위키링크가 코드스팬/기존 hide와 겹침, 인라인코드 안에서도 발동 |
| L11 | P2 | CodeMirrorPreview.tsx:149-155 | Tab/Backspace 편집 중 level 재계산으로 칸 깜빡 |
| L12 | P2 | livePreview.ts:316-321 | 리스트 안 들여쓴 ```mermaid 오탐 |

---

## 4. 아키텍처 판정 + 리팩토링 계획

**판정: 리팩토링 필요.** 모놀리식이 (a) 4종 데코를 한 배열에 섞어 정렬 취약 (b) 3개
reveal 규칙을 한 패스에 혼재 (c) 키 입력마다 전체 재스캔 (d) construct별 테스트 봉합
없음 — 을 구조적으로 유발하고, **망가진 중첩 들여쓰기 로직이 switch 한복판에 얽혀** 작은
버그를 고립 수정 불가하게 만든다. 정석(Ixora/옵시디언) = per-construct ViewPlugin +
공유 `isCursorInRange` + 블록 위젯만 StateField.

### 타깃 모듈 구조 (`prototypes/livePreview/`)
- `util.ts` — `checkRangeOverlap`/`isCursorInRange`(=`editing` 대체) +
  `caretInRange`(접힌 커서, =`caretIn` 대체) + `lineRangeReveal`(=`spansActiveLine`) +
  `iterateTreeInVisibleRanges` + `editorLines`.
- 인라인/줄 = ViewPlugin: `hideMark` `heading` `blockquote` `list` `link` `wikilink`
  `hr` `codeBlock` (각각 `compute()` + `*.spec.ts`).
- 블록 위젯 = StateField: `blocks.ts`(GFM 표; 원하면 이미지). `mermaidCards`/
  `mediaCards`는 이미 정석 — 그대로.

### reveal 통일
"술어 하나"가 아니라 **range 어휘 하나**: 인라인=construct range, 블록/헤딩=line range
모두 `isCursorInRange`. 리스트 마커만 `caretInRange`(접힌 커서, 옵시디언 선택 동작 —
테스트로 보존). `editing`-vs-`spansActiveLine`의 *우연한* 분기는 사라지고, *의도한*
collapsed 변형만 명시적으로 남는다.

### 마이그레이션 순서 (각 단계 그린 유지)
1. **`util.ts` 추출** — `editing`/`caretIn`/`spansActiveLine`를 공유 헬퍼로 재지정
   (동작 불변). `mermaidCards`/`mediaCards`가 import하는 `activeLines`는 re-export.
   → 3종 reveal 불일치 제거.
2. **쉬운 인라인 플러그인부터** 하나씩 ViewPlugin으로 분리, switch 분기 삭제 + spec 추가.
3. **표(+이미지) StateField `blocks.ts`로** — block:true는 field만 가능(유일한 제약).
4. **`list.ts` 마지막** 분리(불릿/태스크/숫자 + 들여쓰기 + collapsed reveal).
5. **고립된 `list.ts`에서 R2 수정**: 시각 스텝 = 실제 `indentUnit` 폭으로 맞추거나
   per-line 소스 폭에서 유도 + 항목의 **모든 줄**에 데코(`editorLines`).
6. **R1 수정**: 위젯이 아닌 hide는 atomic에서 제외(불릿 `- ` 등). 위젯만 atomic.

### 반드시 보존(정석 — 회귀 금지)
`::before` 불릿(빈 줄 캐럿 높이 정상), `coordsAt` 콘텐츠 칸 캐럿(dev#1222),
atomicRanges(위젯만), IME freeze(모든 plugin update에 `isComposing` 가드 공유 헬퍼화),
마커별 슬롯/완료 취소선, mermaid/media 블록 필드.

---

## 5. 권고

- **즉효 타깃 패치(저위험)**: R1(위젯 외 hide는 non-atomic) + R2(스텝=indentUnit,
  전 줄 데코) — 보고된 두 버그를 바로 잡는다. 단 군 #3/#4는 남는다.
- **근본 해결**: 위 단계 리팩토링. 1단계(util 추출)만으로도 reveal 불일치(군 #3)가
  사라지고 위험이 거의 없다 → **1단계부터 시작 권장.**
