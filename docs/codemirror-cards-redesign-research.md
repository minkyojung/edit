# CodeMirror 카드 재구현 — 정공법 조사 & 재설계 (엔지니어용)

> ProseMirror NodeView로 만들어진 카드(이미지·비디오·오디오·시각화)를 CodeMirror 6로
> 옮길 때, 기존 코드를 기계적으로 포팅하지 않고 **CM 생태계의 표준 방식을 먼저 조사한
> 뒤 그 위에서 재설계**한다. 2026-06-05 조사.

## 0. 조사 방법 / 1차 소스

- 우리 카드 실측 인벤토리(보존할 기능): `src/editor/cards/**`, `src/editor/schema/**`
  — 총 ~1,981 LOC (BaseCardNodeView 239, Image 102, Video 140, Audio 203,
  MediaControls 263, CodeBlockViz 447, 스키마 587).
- CM6 공식 Decoration 예제 (codemirror.net/examples/decoration)
- Obsidian 포럼 "custom CodeMirror block widget" + Obsidian Decorations 문서
- `kenforthewin/atomic-editor` — "CM6 markdown editor, Obsidian-style live preview"
  (inlinePreview/imageBlocks/tables/wikiLinks 모듈 export) ← 거의 우리 목표의 레퍼런스
- `sinja.io/.../emera` — CM6 위젯 안에서 React 컴포넌트 렌더(우리 viz와 동형) 사례

## 1. 핵심 패러다임 전환 (이게 재설계의 근본)

| | ProseMirror (현재) | CodeMirror (정공법) |
|---|---|---|
| 카드의 정체 | **노드**(atom). 데이터=노드 attrs | **마크다운 텍스트 그 자체** (`![](...)`, `<video>`, 펜스+meta) |
| 위젯 | NodeView(노드를 그림) | **view-only 데코레이션**(텍스트를 가리고 위젯을 그림) |
| 저장 | 스키마 parseMarkdown/toMarkdown 왕복 | **왕복 없음** — doc 텍스트가 곧 디스크 |
| 편집 | 인라인 다이얼로그/입력/edit-mode UI | **커서가 그 줄 가면 raw 소스 노출 → 텍스트로 편집** |
| 선택 | NodeSelection(atom) | `atomicRanges`로 커서가 건너뜀 |

> 핵심 통찰: CM에선 "카드 = 마크다운 소스의 렌더일 뿐". atomic-editor도
> *"all decorations are view-only — copy/save/round-trip는 plain textarea와 동일"*.
> 이 한 줄이 PM 카드 기계장치의 상당 부분을 **증발**시킨다(§4).

## 2. 공유 아키텍처 (재설계 토대)

1. **제공자 = StateField (ViewPlugin 아님).** 블록 레이아웃을 바꾸는 데코(블록 위젯/
   개행 가로지르는 replace)는 CM 규칙상 **StateField로만** 제공 가능. (공식 문서 +
   Obsidian 포럼 + 우리 스파이크에서 실제로 확인 — 표가 ViewPlugin에서 깨졌었음.)
   구문트리를 걸어 카드 소스를 찾아 `Decoration.replace({ widget, block:true })`.
2. **WidgetType 계약**: `toDOM()` / `eq(other)` / `ignoreEvent()` / `updateDOM(dom)` /
   `destroy(dom)`. CM은 **문서가 바뀔 때마다 위젯을 재생성**하려 하므로 `eq()`가
   생명선 — 소스 문자열(+해석된 src/vizId)이 같으면 `eq`가 true를 반환해 **DOM 재마운트
   회피**(미디어 재생위치·React viz 루트 보존). PM의 `update(node)`+retained ref를
   대체.
3. **상호작용 위젯**(컨트롤·버튼): `ignoreEvent(){return false}` + 위젯 DOM 자체
   리스너(우리 컨트롤은 이미 `stopPropagation`). 또는 플러그인 `eventHandlers` +
   `view.posAtDOM(target)`.
4. **선택/삭제**: 위젯 범위를 `EditorView.atomicRanges`에도 제공 → 커서가 통째로
   건너뜀. 삭제는 keymap(백스페이스 시 그 줄 제거)으로. PM의 atom+NodeSelection 대체.
5. **편집 = 커서줄 raw 노출**: 카드 줄에 커서가 오면 replace를 생략해 원문(`<video src>`,
   펜스 소스) 노출 → 사용자가 텍스트로 편집. PM의 alt-다이얼로그/제목입력/edit-mode를
   전부 대체. (이미 Tier1/Tier2 스파이크의 reveal 규칙 재사용.)
6. **비동기 에셋 해석**: 위젯이 raw src 보유 → `toDOM`에서 `resolveVaultAssetSrc`로
   asset:// 해석(토큰으로 레이스 가드). `eq`가 raw src 비교라 불필요한 재해석 없음.
   기존 `resolveVaultAssetSrc` 재사용.

## 3. 카드별 재설계 + 비용

### 이미지 — 비용 LOW (스파이크에 80% 있음)
- `![alt](src)` 위 inline/block replace + ImageWidget(스파이크의 것 확장).
- 추가: 볼트 상대경로 async 해석, alt/title, 캡션(선택).
- 편집: 커서줄에서 `![alt](src)` 노출 → 텍스트 편집. **alt 다이얼로그 불필요.**

### 비디오 / 오디오 — 비용 MEDIUM, **재사용 큼**
- 디스크 형태(`<video>`/`<audio>` HTML) 유지 → lang-markdown의 HTMLBlock 노드 탐지.
- 블록 replace 위젯이 미디어 엘리먼트 + **`MediaControls.ts`(263 LOC, 순수 DOM)를
  그대로 재사용**(HTMLMediaElement 받음 → 무수정 이식). 큰 이득.
- `eq()`가 src+title 비교 → 편집 중 재생 유지.
- 오디오 제목: PM의 **WebKit contenteditable-input 해킹 전부 삭제** — 제목은 그냥
  `<audio title="...">` 텍스트, 커서줄 노출로 편집. 대폭 단순화.

### 시각화(Mermaid/Artifact/Chart/GitHub) — 비용 MEDIUM-HIGH, 핵심 난관
- 블록 replace 위젯이 **기존 React viz 컴포넌트**(`@/viz/MermaidBlock` 등, `code` prop
  받음)를 마운트 → **viz 컴포넌트 재사용**. 위젯 `toDOM`이 컨테이너+React root 생성,
  `updateDOM`으로 소스 변경 시 remount 없이 re-render, `eq`는 펜스소스+vizId 비교.
- vizId는 펜스 meta(`v:<id>`) = 마크다운 텍스트에 그대로 → `fenceMeta.ts` 재사용,
  **스키마 불필요**.
- 편집: 커서줄에서 펜스 원문 노출 → 편집. **CodeBlockViz의 textarea/edit-mode/
  debounce-sync(상당 LOC) 삭제.**
- 툴바(이동/삭제/AI편집/refresh): 위젯 버튼(`ignoreEvent` false) 또는 CM command/keymap.
  "위/아래 이동"은 텍스트 줄 swap 커맨드로.
- **함정(Emera 교훈)**: 위젯 재생성 빈발 → `eq`/`updateDOM` 규율 없으면 매 타이핑마다
  React remount되어 다이어그램 깜빡임/상태손실. vizId 키 + updateDOM로 안정화 필수.

## 4. PM 기계장치 중 **증발하는 것** vs **재사용**

증발(=재설계로 사라짐):
- 스키마 5종의 parseMarkdown/toMarkdown 왕복(~587 LOC) — 소스가 곧 텍스트라 탐지+렌더만.
- BaseCardNodeView의 드래그-프리뷰-canvas WKWebView 해킹(~239 LOC 상당) — CM 드래그 모델 별개.
- 오디오 WebKit contenteditable 워크어라운드.
- CodeBlockViz의 textarea edit-mode/sync.
- **code-block-ext의 proof-mark-in-fence-meta**(~259 LOC): CM에선 proof 마크가
  데코(앵커층, 이미 구현)지 펜스 meta에 직렬화되지 않음 → 이 복잡성 통째 불필요 가능.

재사용(거의 무수정):
- `MediaControls.ts`(263) — HTMLMediaElement 컨트롤.
- `@/viz/*` React 컴포넌트(카드 외부) — code prop.
- `resolveVaultAssetSrc`, `fenceMeta` 디코더.
- 스파이크의 위젯/StateField/reveal 골격.

→ 종합: **재구현은 가능하고, 총 LOC는 현재 1,981보다 줄 가능성이 큼.** "카드=텍스트의
view-only 렌더"라 PM 특유의 왕복/해킹/edit-mode가 다수 사라지기 때문.

## 5. 리스크 / 미해결

1. **위젯 생명주기 규율**(eq/updateDOM) — 미디어 재생위치·React viz 상태 보존의 관건.
   Emera가 겪은 1순위 함정. 해결책 명확하나 구현 디테일 필요.
2. **블록위젯 편집 UX** — 카드 줄 진입 시 raw 소스 노출이 편집 모델. 긴 `<video>` 태그/
   JSON viz 소스엔 다소 거칠 수 있음(수용 가능성 높음, 손검증 필요).
3. **상호작용 위젯 이벤트** — 컨트롤/툴바 클릭이 CM 선택과 안 싸우게(ignoreEvent+
   stopPropagation). 패턴 확립됨.
4. **성능** — 블록위젯 StateField는 visibleRanges 최적화가 까다로움(전체 doc 스캔). 캐싱
   필요할 수 있음. 일상 노트 규모면 무난.
5. **카드 재정렬 드래그** — PM은 드래그 이동 지원. CM은 텍스트 줄 swap 커맨드/커스텀
   드래그로 대체(viz "위/아래" 버튼 = 줄 swap).

## 6. 레퍼런스 & 권고

- **`kenforthewin/atomic-editor`가 거의 정확한 선례** — CM6 위에 Obsidian식 live
  preview로 inlinePreview·imageBlocks·tables·wikiLinks를 조립형 확장으로 구현, 전부
  view-only. 우리 Tier1/Tier2 + 이미지/표/위키링크가 이미 검증된 셈. 미디어/viz만 우리가
  추가.
- 권고 순서: ①이 재설계안 확정 → ②**대표 증명 스파이크 1개**: viz(Mermaid) 1블록을
  StateField 블록 replace + React 위젯(eq/updateDOM)으로 띄워 "재생/상태 보존 + 편집
  reveal"이 매끄러운지 눈+손 검증(가장 큰 리스크 §5.1를 직접 깸). 미디어는
  MediaControls 재사용이라 그다음.

## 7. 러프 공수 (감)

- 이미지: 0.5일 (스파이크 확장)
- 비디오/오디오: 1.5~2일 (MediaControls 재사용 + HTMLBlock 탐지 + eq)
- 시각화: 3~4일 (React 위젯 생명주기·툴바·AI편집 이벤트가 비용 중심)
- 합계 대략 1주 내외 + 증명 스파이크 0.5~1일. (전면 이주 전체가 아니라 "카드 축"만.)

## 7.1 차트(Mermaid) 컴포넌트 실측 — 증명 스파이크 입력값

- `src/viz/MermaidBlock.tsx` (159 LOC): props `{ code: string, isStreaming: boolean,
  embedded?: boolean }`. mermaid를 **lazy import + 모듈 promise 캐시**, async로 SVG
  렌더(`mermaid.parse`→`render`), 실패/스트리밍 중엔 raw CodeBlock 폴백.
  `embedded=true`면 "본문에 삽입" 버튼 숨김(에디터 내장용으로 의도됨). 테마는
  `usePaletteSignal`로 라이브 반영.
- `mermaid@^11.15.0` 설치됨. CM 위젯에서 React root로 `<MermaidBlock code={src}
  isStreaming={false} embedded/>` 마운트하면 그대로 동작.
- 증명 스파이크 위젯 계약: `eq(o)=o.code===this.code`(불변 시 remount 회피→SVG 보존),
  `updateDOM`에서 DOM에 보관한 React root로 re-render, `destroy`에서 `queueMicrotask`
  unmount. 블록 replace는 StateField로 제공 + `atomicRanges`. 펜스 줄에 커서 오면
  replace 생략(원문 노출 편집).

## 7.2 차트 증명 스파이크 결과 (2026-06-05 실측 완료)

코드: `src/prototypes/mermaidCards.ts`(StateField 블록 위젯 + React root, eq/
updateDOM/destroy) + `mermaidCards.test.ts`(헤드리스 생명주기 증명) + prototype에 배선,
sample에 mermaid 블록 추가. `MermaidBlock`은 동적 import(무거운 graph 지연).

### 판정: **핵심 리스크 통과** — 아키텍처 성립

| 검증 | 방법 | 결과 |
|---|---|---|
| 블록 위젯이 ```mermaid 펜스를 대체 | DOM 덤프(cm-mermaid-card 존재) + 테스트 | ✓ |
| React 컴포넌트가 CM 위젯 안에서 마운트 | 스크린샷(MermaidBlock 폴백 렌더) | ✓ |
| **무관 편집 시 remount/깜빡임 없음** | 테스트: 다른 줄 편집 후 `widget.eq()===true` | ✓ (핵심) |
| 펜스 본문 편집 시 in-place 갱신 | 테스트: `eq()===false` | ✓ |
| 커서가 펜스 줄 → 원문 노출 편집 | 테스트: 위젯 없음 | ✓ |
| 전체 309 테스트 green, typecheck/lint 깨끗 | | ✓ |

### 실 브라우저 확인 (사용자, 2026-06-05)
- 실 브라우저(`#/dev/cm-prototype`)에서 **mermaid 다이어그램이 실제로 렌더됨**(노드/
  분기/엣지 정상). 처음 raw 소스로 보였던 건 **mermaid 첫 로드 지연**(무거운 lazy
  청크)일 뿐 — 새로고침/대기 후 정상 그려짐. headless 스크린샷이 폴백으로 보였던 것도
  같은 timing 원인(에러 아님).
- 남은 cosmetic: **엣지(연결선) 대비 낮음** — 어두운 팔레트에서 lineColor=
  `--muted-foreground`가 흐림. 기능 무관, 테마 토큰 한 줄 튜닝으로 해결 가능(추후).
- 결론: 차트 카드 **통합 + 생명주기(anti-flicker) + 편집모델 + 실제 렌더** 모두 확인.

### 함의
가장 컸던 리스크(§5.1 "React viz가 CM 위젯 churn을 remount 없이 견디나")가 `eq()`/
updateDOM 패턴으로 **결정적으로 해결**됨. 나머지 카드(이미지=거의 완료, 미디어=
MediaControls 재사용)는 이보다 쉬움 → **카드 축 전체 이주 가능 판정.**

## 7.3 이미지·미디어 카드 검증 결과 (2026-06-05)

- **이미지**: Tier 2 스파이크에서 이미 검증됨(인라인 `![](url)` → 실제 `<img>`, 원격
  URL + base64 data-URI 모두 렌더). 별도 카드 코드 불필요.
- **미디어**(`src/prototypes/mediaCards.ts` + `mediaCards.test.ts`):
  - 탐지: lang-markdown이 `<video>/<audio>`를 HTMLBlock이 아니라 **Paragraph 안
    HTMLTag**로 파싱 → Paragraph 텍스트가 미디어 태그면 블록 replace.
  - **`createMediaControls`(263 LOC) 무수정 재사용** + 기존 `[data-card-controls]`
    CSS 그대로 → 위젯이 미디어 엘리먼트 + 커스텀 컨트롤 바 마운트.
  - 스크린샷: **비디오 프레임 + 컨트롤 바("0:00/0:10"), 오디오 컨트롤 바 + 길이
    ("0:09")** 정상 렌더.
  - 생명주기 테스트 4/4: 배치/eq(무관 편집 시 재생 보존)/src 편집 시 non-eq/커서
    노출. PM의 오디오 WebKit contenteditable-input 해킹은 제거(제목=`title` 속성 텍스트).
- 전체 313 테스트 green, typecheck/lint 깨끗.

→ **카드 4종(이미지·차트·비디오·오디오) 전부 CM에서 성립 확인. 카드 축 검증 완료.**

## 8. 출처
- https://codemirror.net/examples/decoration/
- https://docs.obsidian.md/Plugins/Editor/Decorations
- https://forum.obsidian.md/t/how-to-create-custom-codemirror-block-widget/36132
- https://github.com/kenforthewin/atomic-editor
- https://sinja.io/blog/how-i-built-notebook-in-obisidian-emera
- https://github.com/timk75/obsidian-beautiful-mermaid (mermaid in live preview)
