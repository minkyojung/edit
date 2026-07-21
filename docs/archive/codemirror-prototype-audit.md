# CM 프로토타입 구조 감사 — 미검출 결함 전수 점검

목적: 산발 버그를 개별 수정하기 전에, **현재 구현 전체를 구조적으로 훑어 아직
안 드러난 같은 류의 결함**을 찾는다. 3개 영역 병렬 감사(입력/편집, 위젯/카드/수명,
영속/통합). 엔진(livePreview)은 별도 문서 `codemirror-list-engine-review.md` 참조.
2026-06-06. **읽기 전용 분석 — 수정은 별도.**

---

## 0. 헤드라인 (P0) — 라우트를 "열기만 해도" 실제 볼트에 쓴다

`#/dev/cm-prototype`에 들어가는 것만으로(편집·확인 없이) 사용자 볼트가 변경됨.
이는 명시된 보장("E단계는 실제 사용자 노트를 절대 안 건드린다")을 위반.

- **E1 (P0)** `CodeMirrorPreview.tsx:43-46` → `createSlice.openDaily` — 오늘 데일리
  노트가 없으면 **실제 데일리 노트를 만들고 디스크에 flush**(전역 autoflush 500ms).
  탭 스트립(openSlugs)에도 올라감.
- **E2 (P0)** `CodeMirrorPreview.tsx:48-52` → `createWritingChild` — 샌드박스 노트가
  `type:'writing'`인 **실제 노트**(`daily/<date>/⟨CM Prototype Sandbox⟩.md`)로 생성.
  사이드바·검색·위키링크·LLM 컨텍스트·git에 그대로 노출. "격리"가 아님.
- **원인(공통)**: 격리 보장을 *어느 핸들에 쓰느냐*로 구현했지만, 노트의 영속·노출은
  `knownDocs`+`pathForDoc`+상시 autoflush가 결정. 진짜 격리는 **전용 비영속 타입/경로
  또는 knownDocs에 안 들어가는 인메모리 핸들**이 필요.

→ 우선순위 1순위. 이건 폴리시가 아니라 **안전 결함**이므로 리팩토링과 별개로 즉시 격리.

---

## 1. 영속/통합 (CodeMirrorPreview 호스트 + docsStore 연동)

| # | 심각 | 위치 | 증상 / 원인 |
|---|---|---|---|
| E1 | P0 | CodeMirrorPreview.tsx:43-46 | 라우트 진입만으로 실제 데일리 노트 생성·flush |
| E2 | P0 | CodeMirrorPreview.tsx:48-52 | 샌드박스가 실제 writing 노트로 영속·전 영역 노출 |
| E3 | P1 | CodeMirrorPreview.tsx:41 | 제목 충돌 — `⟨CM Prototype Sandbox⟩` 제목의 실제 노트가 있으면 그걸 골라 SAMPLE/편집을 덮어씀(타입 필터 없음) |
| E4 | P1 | CodeMirrorPreview.tsx:93-102 | 빈 노트 시드 — 해소된 slug가 비어있는 실제 노트면 SAMPLE을 그 위에 씀 |
| E5 | P1 | CodeMirrorPreview.tsx:99,116 | `handle.bodyMarkdown` 직접 변경 — 스토어 세터/검증/PM 동기화 우회. 같은 노트가 탭으로 열려 있으면 캐시·PM 분기 → 마지막 flush가 이김(쓰기 손실) |
| E6 | P1 | CodeMirrorPreview.tsx:79-185 (StrictMode) | 이펙트 2회 실행 + `getSandboxDoc` 단일실행(single-flight) 없음 → 샌드박스 노트 2개 생성/2개 EditorView 경합. 시드 쓰기·flush가 `cancelled` 가드 밖 |
| E7 | P1 | CodeMirrorPreview.tsx:120-124 | 디바운스 flush 취소 불가; 자체 800ms < 전역 500ms라 상태 표시가 실제 쓰기와 무관(장식적). 언마운트 후 디스크 쓰기 진행 |
| E8 | P2 | CodeMirrorPreview.tsx:121 | `void flushDirty().then()` — `.catch` 없음(미처리 거부 가능). "error-free" 위반 |
| E9 | P2 | CodeMirrorPreview.tsx:113-117 | 편집 후 flush 전 핸들이 닫히면 본문 미기록(메타-only 분기) → 편집 소실 |
| E10 | P2 | App.tsx:114 / 호스트 | 에러 바운더리 없음 — 한 익스텐션이 throw하면 EditorView가 통째로 빈 화면 |

---

## 2. 입력/편집 (keymap·자동완성·서식·클릭·IME)

| # | 심각 | 위치 | 증상 / 원인 |
|---|---|---|---|
| C1/C2 | P1 | wikilinkNav.ts:31 | **위키링크는 평클릭(무수식)에도 네비게이션 + preventDefault → `[[제목]]` 안에 커서를 못 둠(편집 불가).** linkNav는 Cmd 필요인데 비일관 |
| F1 | P1 | formatCommands.ts:14-55 | `toggleWrap` 마커 감지가 문자열 슬라이스라 `*`/`**` 별칭·중첩(`***x***`) 오판 → 마크다운 깨짐(조용한 데이터 손상) |
| F2 | P1 | formatCommands.ts:18-19 | 선택 경계가 숨김/atomic 마커 영역에 걸치면 마커를 쪼개 문서 손상 |
| K2 | P1 | CodeMirrorPreview.tsx:150 vs 160 | 자동완성 팝업 열렸을 때 Enter: `insertNewlineContinueMarkup`가 완성 수락을 가로챌 수 있음(우선순위가 배열 순서 의존, 상태 미반영) |
| K1/I1 | P1 | imeComposition.ts + imeListContinue.ts | IME가 WebKit 이벤트 순서 가정에 의존(타임윈도우 100ms). compositionend가 텍스트 커밋보다 먼저란 보장 없음 → 데코 조기 재빌드/이중 개행 |
| A1 | P1 | slashCommands.ts:84-87 | 슬래시 메뉴가 리스트/인용 안(`- /`)에서 안 뜸(줄 시작 col 0만). Notion식 불가 |
| A3 | P2 | wikilinkComplete.ts:48 | `inCodeBlock`이 인라인코드(InlineCode/CodeMark) 누락 → 백틱 안에서도 `[[`/`/` 팝업 |
| C3 | P2 | wikilinkNav/linkNav | 클릭 핸들러가 코드스팬 안에서도 발동(트리 미확인, raw 정규식) |
| C4 | P2 | wikilinkNav:19,linkNav:19 | 경계 `<=` 포함이라 닫는 `]]`/`)` 끝 클릭이 네비 발동(인접 링크 모호) |
| I2 | P2 | imeComposition.ts:36-38 | compositionend 누락(포커스 손실 등) 시 `composingField`가 영구 true → 데코 영구 동결(blur/타임아웃 폴백 없음) |
| T1 | P2 | CodeMirrorPreview.tsx:152 | Tab 무조건 indent → 에디터 밖 포커스 이동(접근성) 불가 |

---

## 3. 위젯/카드/리소스 수명 (mermaid·media·drop·highlight·widgets)

| # | 심각 | 위치 | 증상 / 원인 |
|---|---|---|---|
| W1 | P0 | mermaidCards.ts:30-39 | 동적 import 후 `root.render` fire-and-forget — destroy 후에도 인플라이트 import가 옛 root에 render(언마운트 root 경고/유령 렌더). 취소 토큰 없음 |
| W2 | P0 | CodeMirrorPreview.tsx:167 + mediaDrop.ts:35 | `URL.createObjectURL` **revoke 전무** — 드롭/붙여넣기마다 blob URL 누수(파일 전체 메모리 보유) |
| W3 | P1 | mediaCards.ts:47-49 | MediaWidget `updateDOM` 없음 → 태그 편집 시 `<video>` 파괴·재생성(재생위치 손실). "상태 보존" 약속이 절반만 |
| W4 | P1 | widgets.ts:82-100 | CheckboxWidget `destroy()` 없음 → `mousedown` 리스너 미제거(stale `pos` 클로저) |
| W5 | P1 | mediaCards.ts:50-67 | `<video preload=auto>` 전체 선다운로드 + eq 변동 시 재다운로드. `src` 스킴 검증 없음(`javascript:`/`data:`) |
| W6 | P1 | widgets.ts:113-156 | TableWidget 파서 취약 — 이스케이프 파이프 `\|` 미처리, delim 오탐, ragged 컬럼 미정규화(주입은 textContent라 안전) |
| W7 | P1 | highlights.ts:22-47 | 하이라이트 앵커가 occurrence count(indexOf)라 동일 텍스트 편집 시 다른 인스턴스로 드리프트/소실. RangeSet.map 미사용 |
| W8 | P2 | widgets.ts:65,157 | `estimatedHeight` 상수(240/120) → 오프스크린 블록 위젯 스크롤 점프 |
| W9 | P2 | widgets.ts:57-64 | ImageWidget onerror/destroy 없음(깨진 이미지 박스, blob revoke 안 됨) |
| W10 | P2 | mediaCards.ts:88-104 | `<video`로 시작하는 문단을 통째 블록 카드로 → 주변 산문까지 먹음 |
| W11 | P2 | 카드 필드 다수 | `tr.selection`마다 전체 재빌드 + mermaid/table 겹침 회피가 양쪽 `info==='mermaid'` 문자열 체크에 의존(취약 계약) |

---

## 4. 시스템적(반복) 근본원인 — 리팩토링의 진짜 타깃

1. **격리 보장이 잘못된 레이어**(E1·E2·E3·E5) — 핸들 기준이 아니라 노트 타입/경로/
   인메모리로 격리해야 함. → 최우선 안전 수정.
2. **fire-and-forget 비동기에 liveness 가드 없음**(W1·W3, mediaDrop, save) — 해소 후
   파괴된 리소스(React root/EditorView/handle) 접근. 취소 토큰/`isConnected`/세대 카운터 필요.
3. **destroy()/정리 비일관**(W2·W4·W9) — 리스너·objectURL·React root 누수. "리스너/URL/
   root를 만들면 destroy 필수" 규칙 부재.
4. **트리 대신 raw 정규식·문자열 슬라이스**(F1·C3·C4·A3) — 코드스팬 오탐·경계 오류·중첩
   마크 오판. `inCodeBlock`조차 인라인코드 누락.
5. **조율되지 않은 mousedown 스택**(C1·하이라이트·체크박스·링크) — 우선순위/모디파이어
   게이트 없음. 위키링크 평클릭이 모든 클릭을 가로챔.
6. **위치 앵커를 RangeSet.map 대신 occurrence-count로**(W7) — 편집 시 드리프트.
7. **IME를 이벤트 상관 대신 타임윈도우로**(K1·I1·I2) — WebKit 순서 가정 불안정.
8. **우선순위를 상태가 아닌 배열 순서로**(K2·T1) — 팝업 열림/리스트 여부 같은 문맥 미반영.
9. **스토어 불변식 우회**(E5) — `bodyMarkdown` 직접 대입.

---

## 5. 권고 (우선순위)

1. **즉시(안전, 리팩토링과 별개)**: §0 P0 격리 수정 — 전용 비영속/인메모리 샌드박스로
   바꿔 라우트 진입이 볼트를 안 건드리게. + W1/W2 누수(취소 토큰·revoke).
2. **엔진 리팩토링 Phase 2~3**(별도 문서) — R1/R2 + per-construct 분리. 패턴 #4·#5·#6도
   분리 과정에서 구조적으로 해소.
3. **입력층 정리**: 통합 mousedown 디스패처(#5), 트리 기반 위치판정(#4), IME 인터록(#7),
   keymap 우선순위 명시(#8).
4. **위젯 수명 규칙**(#2·#3): 공유 `destroy`/취소 패턴, MediaWidget `updateDOM`, objectURL 소유·revoke.

**메모**: 대부분은 "프로토타입이라 가짜데이터/단순구현"의 산물이라 E단계(에디터 셸
배선) 프로덕션화에서 자연 해소될 것도 있으나, **§0 격리 P0는 지금도 실제 볼트를 쓰므로
즉시 처리**가 맞다.
