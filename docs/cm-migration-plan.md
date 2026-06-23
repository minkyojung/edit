# Milkdown(ProseMirror) → CodeMirror 6 안전 이관 계획

> **현실(2026-06): CM이 이미 기본 에디터다.** `cmEditorEnabled` 설정이 켜져
> 있고(`Page.tsx`가 그 값으로 분기), 데일리 드라이버가 CM(`CmEditor` +
> `prototypes/v2/livePreview` 등). Milkdown(`MilkdownEditor`)은 **폴백/레거시**.
> 따라서 이 문서는 "옮기는 계획"이 아니라 **"CM을 정식 기본으로 굳히고 PM을
> 안전하게 제거하는 계획"** 이다.
>
> 단, 설정 *기본값*은 아직 `cmEditorEnabled: false`(=Milkdown) — **기본값과
> 실사용이 어긋난 상태**. 1순위는 이 간극을 닫는 것(아래 "정식 승격").
>
> 동기: 무거운 NodeView(리스트 마커 = Vue per item, 카드/시각화 = React
> `createRoot` per node)를 CM의 가벼운 decoration/widget으로 대체 → 이미
> 리스트/체크박스 즉시 전환은 적용 완료.

## 정식 승격 + PM 제거 게이트 (이 문서의 1순위)

PM을 지우기 전에 **CM이 PM의 모든 산출을 대체하는지** 확인해야 한다. 순서:

1. **기본값 전환**: `cmEditorEnabled` 기본 true (또는 토글 자체 제거).
   전제 = 아래 패리티/의존성 점검 통과.
2. **PM 전용 의존성 인벤토리**: 아직 PM(Milkdown)만 처리하고 CM엔 없는 기능을
   전수 확인 — 시각화 NodeView, propose-edit/AI 마크 앵커, 마크다운 parser/
   serializer 단일 진실, frontmatter, 기타 플러그인. 하나라도 CM에 공백이면
   제거 보류.
3. **참조 제거**: `MilkdownEditor` + `@milkdown/*` import, PM 전용 플러그인/
   schema/NodeView, 토글 UI를 단계적으로 삭제. 각 삭제마다 빌드/테스트 그린.
4. **안전망**: 삭제 전 §2(차등 하베스트)로 CM 단독 회귀 확인.

### 실측: PM 결합도 (2026-06)

`@milkdown`을 **83파일이 import** — 59는 `src/editor/`, **24는 에디터 밖**.
즉 PM은 폴백 에디터가 아니라 앱 전역에 박혀 있어 "삭제"가 아니라 "디커플
서브프로젝트"다.

에디터 밖 24개 분류:
- **공유 마크다운 로직 (lib/, 높음)**: `markdownAppend` · `markdownBlockMap`
  · `computePendingHunks` · `stripPendingFromDoc` · `seedMarkdown` ·
  `docTitle` · `stripTrailingEmptyParagraphs` · `cleanupYdocV2` — PM 스키마
  기반 변환 → Lezer/문자열 기반으로 교체해야 함.
- **마크다운 단일진실 (높음)**: `state/editorViewStore` (Milkdown이 parser/
  serializer publish).
- **챗 AI 편집 적용 (중)**: `chat/useChatRunner` · `agent/chat/types`.
- **에디터 plumbing (낮음)**: `AppShell`/`ChatPanel`/`RightPanel`/`EditorHeader`
  /`DocMenu`/`Page` 등 — PM `EditorView` 타입/뷰 전달. Milkdown 제거 시 정리.

제거 순서: 인벤토리 확정 → lib 마크다운 변환 CM화 → 챗 적용 CM 단일화 →
EditorView 타입 통일 → `MilkdownEditor`+`@milkdown/*` 삭제. 각 단계 차등 게이트.

## 0. 왜 CM6 구조가 안전에 유리한가

| CM6 개념 | API | 안전 효과 |
|---|---|---|
| State/View 분리, 불변 state | `EditorState.update()` | 편집 로직을 DOM 없이 단위테스트 |
| 모든 편집이 1개 Transaction | `view.dispatch(tr)` | `transactionFilter`로 불변식을 한 곳에서 강제 |
| Decoration + RangeSet 자동 매핑 | `RangeSet.map`, `EditorView.decorations` | AI 제안 앵커 안정성이 PM보다 견고 |
| StateField vs ViewPlugin 규칙 | `StateField.define` / `ViewPlugin.fromClass` | 카드/시각화 높이 깨짐을 규칙으로 예방 |
| Compartment | `Compartment.reconfigure` | readonly/테마/daily 모드 안전 전환 |
| atomicRanges + replace widget | `EditorView.atomicRanges`, `Decoration.replace` | 카드/시각화/인라인이미지 편집 깨짐 방지 |

**컨벤션 한 줄**: *높이/블록에 영향 = StateField, 화면에 보이는 것만 = ViewPlugin.*

## 1. 무거운 NodeView → CM 대체 매핑

- 리스트 마커 → StateField `Decoration.line`/`mark` 또는 CSS `::marker`
- 카드(이미지/오디오/비디오/시각화/인라인이미지) → `Decoration.replace({ widget })`
  + `atomicRanges`. 위젯 안에서 **기존 React 컴포넌트를 블록당 1회 mount**.
- proof 마크(AI 제안) → `RangeSet` 데코, 변경 시 자동 매핑
- 뷰포트 의존(라이브프리뷰 reveal, 호버바) → ViewPlugin

## 2. 안전망 (이관 전에 깔 것 — 핵심)

기반: `src/editor/__poc__/`(anchorStability PM/CM 동률 테스트, `prng.ts` 퍼징,
`measureStatics`) + `src/prototypes/`. 이걸 **차등(differential) 게이트**로 승격.

1. **차등 테스트** — 같은 마크다운(코퍼스 + 퍼징)을 PM·CM 양쪽에 투입, 단언:
   - (a) 마크다운 왕복 동일
   - (b) 렌더 구조/텍스트 동등
   - (c) 랜덤 편집열 후 앵커 위치 동등 (harness 존재)
2. **엣지케이스 코퍼스**: 한글 IME 조합, 붙여넣기/정리, undo/redo, 중첩 리스트,
   list enter/backspace, 표, 위키링크, 마크 경계, 빈 문서, 초대형 문서.
3. **섀도우 듀얼런(dev)**: CM을 숨겨 같이 마운트 → 트랜잭션 미러링 → diff 로그.
4. **롤백**: 문서/전역 피처플래그(`EditorSettings`에 두 에디터 참조 존재).

## 3. 단계별 이관 (각 단계 사이 게이트 = §2 차등테스트 통과)

| Phase | 내용 | 위험 | 게이트 |
|---|---|---|---|
| 0. 안전망 | 차등 하베스트 + 코퍼스 + 섀도우런 | 낮음 | 코퍼스/퍼징 그린 |
| 1. 읽기전용 렌더 패리티 | md→CM 문서+데코가 Milkdown과 시각 일치(편집 X) | 낮음 | 스냅샷/시각 일치 |
| 2. 무거운 NodeView 교체 | 리스트마커·카드·시각화·인라인이미지 → 데코/위젯(atomic) | 중 | 렌더+상호작용 패리티 |
| 3. 편집+플러그인 | ~30 플러그인·키맵·IME·표 | 높음 | 랜덤 편집열 차등 + IME 수동 |
| 4. proof 앵커 단일화 | AI 제안 마크/앵커 → CM RangeSet | 중 | 앵커 퍼징 동률 |
| 5. 컷오버 | 피처플래그 → 도그푸드 → 기본 전환 → Milkdown 제거 | 중 | 도그푸드 무이슈 N일 |

원칙: 빅뱅 금지. 1→2→3 순서.

## 4. 같이 가져갈 구조적 개선

1. **마크다운 단일 진실**: Lezer-markdown 기반 parser/serializer 하나 +
   왕복 불변식 테스트 (현재 "두 schema drift" 버그류 차단).
2. **transactionFilter 단일 불변식 지점**: 프론트매터/atomic/daily 보호 통합.
3. **데코 출처 규율**(§0 컨벤션)을 리뷰 체크리스트로.
4. **렌더 프레임워크 분리**: 카드/시각화는 React 유지하되 CM 위젯으로 mount.

## 5. CM6 함정 (꼭 피할 것)

- 블록높이 바꾸는 데코는 ViewPlugin에서 주면 안 됨 → StateField +
  `EditorView.decorations` facet.
- 위젯엔 `atomicRanges` 필수 (커서가 카드 안으로 들어가는 편집 깨짐 방지).
- IME(한글 조합) 중 transactionFilter로 변경 가하면 조합 깨짐 → `view.composing`
  가드. (가장 큰 지뢰)
- measure 단계 비동기 — dispatch 중 동기 레이아웃 읽기 금지(rAF).
- 익스텐션은 identity로 dedup — 싱글톤 export.

## 인벤토리 (옮길 대상 전체)

### 무거운 NodeView (1순위, §1)
list-item-block · cards/{Image,Audio,Video}CardNodeView · CodeBlockVizNodeView
· imageInlineNodeView · customCaretPlugin · frozenSelectionPlugin

### 플러그인 ~30 (대부분 PoC 존재)
키맵(list/heading/inlineCode) · history · clipboard · dailyGuard · proofSchema
· vizId · docVersion · dirtyTracker · inlineReview · formatState · dropCursor
· mediaDropPaste · pasteSanitizer · link click/hover · slashTrigger
· wikilink click/broken/sync/palette · highlightClick · aiEditGutter · placeholder

### 스키마/마크/변환
schema: image-block · audio-block · video-block · code-block-ext · frontmatter
· proof-marks / marks: proofMarks(AI) · highlight · wikilink(link mark)
/ 마크다운 ↔ 문서 변환 (현재 Milkdown 단일 진실)

### 좋은 소식
실시간 collab(y-prosemirror)은 이미 제거됨 → CM 이관 시 y-codemirror 바인딩
부담 작음. Y.Doc은 콘텐츠 로딩에만 잔존.

---

# Phase 0 상세 설계 — 차등 안전망 (Differential Parity Harness)

## 핵심 통찰: CM = 마크다운 소스가 곧 문서

Milkdown은 `마크다운 → PM 노드 모델 → 마크다운` 왕복을 한다. 이 왕복이
**에디터 버그의 1순위 출처**(두 schema drift, list_item.spread, 마크 경계
재직렬화 등 — `MilkdownEditor.tsx` 주석이 겪은 고통). CM 라이브프리뷰는
**문서 = 마크다운 소스 문자열**이고 Lezer 마크다운 구문트리로 데코를 그린다.
→ **왕복 자체가 없어 그 버그 클래스가 통째로 사라진다.** Phase 0의 패리티는
"CM 소스 편집이 PM이 직렬화할 마크다운과 같은가"를 보장하는 데 집중한다.

## 기존 자산 (재사용)

`src/editor/__poc__/`:
- `anchorStability.types.ts` — `EditorAdapter<H>` 계약(init/applyUserOp/
  probe/accept/dispose), 편집 연산 `Op`(literal `find`로 위치 — 앵커로직
  비순환), `Fixture`.
- `anchorStability.harness.ts` — `runScript`(init→ops→probe).
- `prng.ts` — `mulberry32` 결정적 퍼징.
- `adapters/{pmAdapter,cmAdapter,cmAnchor}.ts` — 양쪽 구현.
- 테스트: `anchorStability.{pm,cm}.test.ts`, `measureStatics.test.ts`.

→ **앵커 안정성(축 C)은 이미 차등으로 돈다.** Phase 0은 축 A·B를 추가한다.

## 패리티 3축 (정확한 정의)

| 축 | 단언 | 왜 |
|---|---|---|
| **A. 마크다운 동등** | 같은 `Op` 시퀀스 적용 후 `currentMarkdown(PM) === currentMarkdown(CM)` | CM 소스 편집이 PM 직렬화와 같은 결과를 내는지 |
| **B. 렌더 구조 동등** | `toStructure(PM)` ≡ `toStructure(CM)` (정규화 후) | 라이브프리뷰 데코가 PM 렌더와 같은 블록/마크 구조인지 (Phase 1과 공유) |
| **C. 앵커 동등** | `runScript` 결과 동일 (기존) | AI 제안이 편집 중에도 안 어긋나는지 |

> A는 멱등성도 본다: `serialize(parse(serialize(parse(md))))` == `serialize(parse(md))` (PM 측 불변식 회귀).

## 어댑터 계약 확장

`EditorAdapter<H>`에 2개 추가 (두 어댑터 모두 이미 disk-side bodyMarkdown을
내부 유지 → 노출만 하면 됨):
```ts
currentMarkdown(handle: H): string         // 축 A
toStructure(handle: H): StructNode         // 축 B
```
`StructNode` = 엔진 중립 정규화 트리:
```ts
type StructNode = {
  type: string                  // 'heading' | 'bullet_list' | 'list_item' | 'paragraph' | 'code_block' | 'image' | ...
  attrs?: Record<string, string | number | boolean>  // level, listType, checked, lang, src...
  marks?: string[]              // 텍스트 노드의 mark 이름들 (정규화·정렬)
  text?: string
  children?: StructNode[]
}
```
정규화 규칙(엔진 차이 흡수): 인접 텍스트 병합, 마크 이름 정렬, 공백 trim
정책 일치, 빈 paragraph 처리 통일.

## 코퍼스 설계 (`__poc__/corpus.ts`)

태그된 fixture 집합 — 실패가 어느 기능인지 바로 짚이게. 각 항목 `{ id, tags,
markdown }`.

- **인라인**: bold/italic/code/strike/link/wikilink/highlight, 중첩 마크,
  줄 경계의 마크, 인접 마크, 이스케이프 문자.
- **블록**: heading h1–h6, paragraph, bullet/ordered/task 리스트(중첩·혼합·
  빈 항목), blockquote, code fence(일반 + mermaid/artifact/chart), 표, hr,
  frontmatter, image/audio/video, hard break.
- **엣지**: 빈 문서, frontmatter만, 선/후행 공백, 연속 빈 줄, CRLF, 초대형
  문서, 한글/이모지/유니코드, 깊은 중첩 리스트.

각 fixture는 **기능→커버리지 체크리스트**(노드·마크·플러그인 매핑)에 연결.

## 퍼징 (`__poc__/fuzz.ts`, prng 재사용)

- `fuzzDoc(seed)`: 블록/마크 문법에서 랜덤 문서 조립.
- `fuzzOps(seed, doc)`: 랜덤 `Op`(insert/delete/replace, literal `find`).
- **결정적**: 실패 시 시드를 출력 → `repro(seed)`로 1:1 재현.

## 차등 러너 (`__poc__/parity.test.ts`)

```
for doc in (CORPUS ∪ fuzzDocs(seeds)):
  pm = pmAdapter.init(asFixture(doc)); cm = cmAdapter.init(...)
  expect(currentMarkdown(pm)).toEqual(currentMarkdown(cm))            // A
  expect(norm(toStructure(pm))).toEqual(norm(toStructure(cm)))        // B
  for op in fuzzOps(seed, doc):
    pm = applyUserOp(pm, op); cm = applyUserOp(cm, op)
    expect(currentMarkdown(pm)).toEqual(currentMarkdown(cm))          // A under edits
  // 축 C는 기존 anchorStability 스위트가 담당
```

## 섀도우 듀얼런 (dev 전용, 설계만 — 이후 구현)

`MilkdownEditor` 옆에 CM을 **숨겨서** 마운트 → PM 트랜잭션이 만든 마크다운을
CM 소스에 미러 → 매 변경마다 축 A·B diff를 콘솔 로그. 실제 사용 중 불일치를
**컷오버 전에** 포착. 피처플래그 `editor.shadowParity`로 on/off.

## 게이트 / CI

- 코퍼스 패리티: 100% 그린 (블로커).
- 퍼징: N 시드 실행, 1건이라도 실패 = 블로커(시드 첨부 repro).
- 커버리지 체크리스트: 모든 노드/마크/플러그인이 최소 1개 fixture로 덮임.

## Phase 0 산출 파일

- `__poc__/corpus.ts` (태그된 코퍼스)
- `__poc__/fuzz.ts` (문서/연산 퍼저)
- `__poc__/structure.ts` (`StructNode` + 정규화)
- 어댑터 2종에 `currentMarkdown` / `toStructure` 추가
- `__poc__/parity.test.ts` (차등 러너)
- (이후) 섀도우 듀얼런 dev 플러그인
