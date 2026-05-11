# Studio — AI-Native 글쓰기 패널 아키텍처

채팅 패널 옆에 들어갈 "Studio" 탭의 기능 후보 + 기반 설계.
세 기능(Reader Simulator, Reverse Outline, Argument Sparring)을 하나의 프레임워크 위에 mode 플러그인으로 얹는 방향.

---

## 1. 배경

### 1-1. 출발점
Thariq Shihipar(Claude Code 팀)의 "Why HTML?" 글에서 가져온 핵심 아이디어:
- Markdown은 100줄 넘어가면 안 읽힌다
- HTML은 표, SVG, 인터랙션을 한 파일에 담을 수 있다
- 사용자가 슬라이더·드래그로 조절하면 Claude가 새 HTML을 생성하는 양방향 루프가 가능하다
- 결과를 다시 본문에 반영하는 패턴이 강력하다

### 1-2. 우리에게 있는 자원
- **글**: writer-tauri의 본문 (Milkdown + ProseMirror + Yjs)
- **proof-sdk**: 본문에 anchor 가능한 마크 시스템
  - `proofSuggestion` (id, kind, by, sourceSlug, sourceLabel, sourceQuote, proposedAt)
  - `proofComment` (id, by, text, quote, note)
  - `proofFlagged`, `proofApproved`
  - `proofAuthored` (모든 텍스트의 작성자)
  - `proofProvenance` (수락된 AI 텍스트의 영구 출처 흔적: sourceSlug, sourceLabel, sourceQuote, proposedAt, acceptedAt, model)
- **HTML**: 풍부한 시각화 + 양방향 인터랙션
- **Claude**: 생성·시뮬레이션·구조 추출·반론 생성

### 1-3. AI-aware vs AI-native
처음 떠올린 후보(Board, Origin Heatmap, Provenance Timeline)는 "AI가 한 일을 보여주는" AI-aware 뷰였다. AI-native는 한 발 더 나간 형태:

> Claude가 **그 자리에서 새 HTML 아티팩트를 생성**하고 → 사용자가 슬라이더·드래그로 조절하고 → 결과가 다시 proof 마크로 본문에 박힌다.

이 양방향 루프 위에 세 기능을 설계.

---

## 2. 기능 후보 (v1 타깃)

### 2-1. Reader Simulator
> 가상 독자 페르소나로 Claude가 글을 읽고 어디서 막혔는지 시각화.

| 항목 | 내용 |
|---|---|
| JTBD | 작가가 못 보는 독자 시점을 빌려서 약점 발견 |
| 트리거 | 우측 패널 "Reader" 모드. 페르소나 선택 (비전공 30대, 분야 전문가, 회의적 비평가, 10대, 바쁜 임원, 커스텀) |
| 화면 | ① 글 미니맵에 페르소나가 막힌/지루해한 구간 색깔 오버레이 ② 페르소나 코멘트 카드 ③ 끝까지 읽은 비율 + 핵심 메시지 회상 |
| 액션 | 코멘트 클릭 → `proofComment(by=ai:reader:<persona>)`, "이 의견대로 고쳐줘" → `proofSuggestion` |
| 노브 | 페르소나 속성 슬라이더 (지식 수준, 호의도, 주의력) |
| 멀티 모드 | 페르소나 N명 동시 읽기 → 공통적으로 막힌 구간이 빨간 점으로 부각 |
| 차별점 | 다른 글쓰기 도구가 흉내내기 어려움. "AI 시대 글쓰기 도구의 정체성" 카드 |

### 2-2. Reverse Outline
> 완성된 글을 거꾸로 읽어서 실제 논증 구조를 트리로 재구성.

| 항목 | 내용 |
|---|---|
| JTBD | "쓸 때 의도"와 "실제 쓴 글"의 차이를 시각화 |
| 화면 | SVG 트리. 각 노드 = 섹션. 색 = 근거 충분(초록) / 약함(노랑) / 없음(빨강). 빨간 노드 클릭 시 근거 후보 카드 (다른 노트 인용, Claude 추론, 웹 검색) |
| 액션 | 근거 카드 → `proofSuggestion(kind=insert)` / 노드 드래그 → 섹션 순서 재배치 transaction |
| 차별점 | 글쓴이 본인의 약점을 객관화. proof-sdk의 sourceSlug 인덱스 재활용 |

### 2-3. Argument Sparring
> Claude를 반대 입장 에이전트로 세팅해 글의 주장을 강화.

| 항목 | 내용 |
|---|---|
| JTBD | 주장 글의 약점을 작가 본인이 못 보는 문제 |
| 트리거 | 본문에서 주장 단락 선택 → "Spar" 모드 |
| 화면 | 좌-우 카드: 왼쪽 = 내 주장, 오른쪽 = Claude의 강한 반론. 반론에 근거 (다른 노트 인용 포함). 라운드 stack으로 쌓임 |
| 액션 | "이 반론 흡수" → `proofSuggestion(kind=insert)`로 "물론 ~라는 반론도 있다. 그러나..." 단락 삽입 / "토론 전체 흡수" → 다단계 균형 단락 |

---

## 3. UI 와이어프레임

### 3-1. 패널 구조 (공통)

```
┌─────────────────────────────────────────────┐
│ ◯ Chat    ◉ Studio              ⋯    ↗    │  ← 헤더 1 (탭)
├─────────────────────────────────────────────┤
│ [Variants] [Reader] [Outline] [Spar]        │  ← 헤더 2 (Studio 내 모드)
│                                              │     선택 컨텍스트 없으면 회색 비활성
├─────────────────────────────────────────────┤
│         (모드별 컨텐츠)                       │
└─────────────────────────────────────────────┘
```

- 헤더 1: Chat ↔ Studio 토글. 둘 다 같은 패널 자리.
- 헤더 2: Studio 내부 모드. 본문 선택 컨텍스트에 따라 활성/비활성.

### 3-2. Reader Simulator 화면 예시

페르소나 선택 → Claude가 읽기 시작 → 리포트:
- 끝까지 읽은 비율 progress bar
- 글 미니맵에 색 오버레이 ("용어 어려움", "여기서 둔화", "이탈 지점")
- 페르소나 코멘트 카드: 인용 + 의견 + [→ 그 위치로] [코멘트 박기] [Claude에게 이 의견대로 고쳐달라]
- 페르소나 속성 슬라이더 (지식, 호의도, 주의력) → 다시 읽혀보기

본문에는 페르소나 코멘트가 작은 ▼ 아이콘으로 마진에 표시. hover 시 아바타 + 코멘트 팝오버.

### 3-3. Reverse Outline 화면 예시

SVG 트리 다이어그램. 노드 색으로 근거 상태 표시. 선택된 노드에 대해 하단에 근거 후보 3종 카드:
- ① 다른 노트에서 인용 가능한 부분 (sourceSlug)
- ② Claude 추론에 기반한 단락
- ③ 웹 검색 결과 (외부 출처)

노드 드래그 시 본문 섹션 순서 재배치는 확인 모달 한 번 띄움.

### 3-4. Argument Sparring 화면 예시

```
라운드 1 ─────────
[나의 주장]    [Claude 반론]
                근거: 노트 X 인용, Claude 추론
[ 이 반론 흡수 ↗ ]   [ 더 강한 반론 부탁 ]

라운드 2 ─────────
(사용자 답변 입력 또는 Claude 추가 반론)

[ 전체 토론을 글에 흡수 ↗ ]
```

---

## 4. UX 헌법 (공통 인터랙션 원칙)

| 원칙 | 적용 |
|---|---|
| **본문이 항상 진실의 원천** | Studio는 본문에서 선택하면 활성, 결과는 마크로 본문에 박힘. 별도 영구 저장 없음. |
| **두 단계 수락** | Studio에서 "적용" = `proofSuggestion` 박기. 본문에서 ✓ 누르면 실제 텍스트 교체. 돌이킬 수 있는 단계가 두 번. |
| **stale 표시** | 본문 변경 시 ↻ 배지 (깜빡이지 않음 — 글쓰기 흐름 방해 금지). |
| **선택 컨텍스트 = 모드 가용성** | 모드 탭은 항상 보이지만, 선택 없으면 회색 + 안내 토스트. |
| **본문 ↔ 패널 시선 연동** | 패널 카드 hover → 본문 해당 위치 하이라이트. 본문 마크 클릭 → 패널 관련 카드 강조. |
| **생성 비용 가시화** | 슬라이더 한 번 = 토큰 N개. 작은 카운터 우하단 표시. |

### 디자인 톤
- HTML 아티팩트가 본문보다 톤이 들뜨면 안 됨. 본문이 가장 차분해야 함.
- 카드 그림자 최소, 단색 보더 1px. 색은 의미 전달 용도만.
- 슬라이더 macOS native 톤. 트리·미니맵은 SVG, 단색 + 회색조 + 단일 강조색.
- 카드 재생성 fade-in/out 120ms. 그 이상 산만함.

---

## 5. 기반 아키텍처

### 5-1. 공통 추상

세 기능을 추상화하면 모두 같은 파이프라인:

```
[문서 컨텍스트] → [Claude 호출] → [HTML 아티팩트]
                                      ↓
                                  [사용자 조작]
                                      ↓
                          [proof 마크로 본문에 anchor]
```

차이는 4가지 파라미터뿐:

| 파라미터 | Reader | Outline | Spar |
|---|---|---|---|
| 입력 스코프 | 문서 전체 | 문서 전체 | 선택된 단락 |
| 프롬프트 템플릿 | 페르소나 시뮬레이션 | 구조 추출 + 약점 분석 | 반론 생성 |
| 출력 스키마 | { heatmap, comments[] } | { tree, weakNodes[] } | { rounds[] } |
| 결과 마크 종류 | proofComment, proofFlagged | proofSuggestion | proofSuggestion |

→ Mode 인터페이스 1개로 추상화 가능. 새 기능 추가는 mode 등록만으로 끝.

### 5-2. 동작 사이클 (8단계)

```
1) 사용자가 본문에서 무언가를 선택하거나 모드 진입
2) ContextExtractor가 입력 스코프에 맞춰 텍스트 + 마크 + 출처 추출
3) ModeRunner가 mode의 프롬프트 + 컨텍스트로 Claude 호출 (스트리밍)
4) ArtifactValidator가 Claude 출력을 mode의 출력 스키마(Zod)로 검증
5) ArtifactRenderer가 검증된 데이터를 호스트 React 컴포넌트로 렌더
6) 사용자가 HTML 안에서 액션 (카드 클릭, 노드 드래그 등)
7) MarkBridge가 액션을 proof 마크 transaction으로 변환 (markActions.ts 호출)
8) 본문 변경 감지 시 stale 표시. ↻ 누르면 1번부터 다시.
```

이 중 **1, 3, 5만 mode마다 다르다.** 나머지는 공통 기반.

### 5-3. 코드 구조

```
src/studio/
  modes/
    types.ts              ← Mode 인터페이스
    readerMode.ts         ← Reader Simulator
    outlineMode.ts        ← Reverse Outline
    sparMode.ts           ← Argument Sparring
    index.ts              ← registry
  
  context/
    extractor.ts          ← 입력 스코프별 컨텍스트 추출
    contextTypes.ts
  
  runner/
    modeRunner.ts         ← Claude 호출 + 스트리밍 + 재시도
    promptBuilder.ts
    artifactValidator.ts  ← Zod 검증
  
  renderer/
    ArtifactView.tsx      ← mode별 컴포넌트 라우터
    components/           ← Heatmap, Tree, RoundCard 등
  
  bridge/
    markBridge.ts         ← 액션 → proof 마크 transaction
                            (markActions.ts 호출만, PM 로직 X)
  
  state/
    artifactStore.ts      ← 결과 + stale + 캐시
    studioPanel.ts        ← 패널 상태
  
  StudioPanel.tsx         ← 루트
```

### 5-4. Mode 인터페이스

```ts
interface StudioMode<TParams, TArtifact> {
  id: string                       // 'reader' | 'outline' | 'spar'
  label: string
  inputScope: 'selection' | 'document' | 'claim'
  
  // 1단계: 컨텍스트 추출
  buildContext(state: EditorState, params: TParams): ModeContext
  
  // 3단계: 프롬프트
  buildPrompt(ctx: ModeContext, params: TParams): ClaudePrompt
  
  // 4단계: 검증 (Zod)
  artifactSchema: ZodType<TArtifact>
  
  // 5단계: 렌더링
  Component: React.FC<{
    artifact: TArtifact
    onAction: (a: ModeAction) => void
  }>
  
  // 6→7단계: 액션 → 마크
  reduceAction(action: ModeAction, ctx: ModeContext): MarkTransaction[]
}
```

### 5-5. 기존 시스템과 연결되는 5개 지점

| 연결 지점 | 위치 | 역할 |
|---|---|---|
| **PM editor state 구독** | `MilkdownEditor.tsx` → `studioPanel` store에 selection 변경 publish | mode 활성 조건 판단 |
| **마크 적용** | `markBridge.ts` → `markActions.ts` 호출 | proof 마크 박기 (PM tx + Y.Map) |
| **마크 → 패널 역방향 anchor** | `markClickPlugin.ts` 확장: `sourceArtifactId` attr 있으면 패널 열고 카드 강조 | 양방향 |
| **doc version** | `docVersionPlugin.ts` 값을 artifactStore가 구독 | stale 판단 |
| **sourceSlug 인덱스** | 기존 wikilink 인덱스 + 노트 트리 재활용 | Outline의 근거 후보 |

→ 기존 `src/editor/`는 거의 안 건드림. mark schema에 `sourceArtifactId` 한 줄만 추가.

---

## 6. 핵심 결정 4가지

지금 못 정하면 나중에 비싸지는 결정.

### 6-1. HTML 렌더링: 호스트 React 컴포넌트 (iframe 아님)

Claude가 자유 HTML 문자열을 뱉으면 XSS·CSS 충돌·이벤트 브릿지 모두 비싼 문제로 변함. Claude Code 글쓴이의 패턴은 "HTML 파일 → 브라우저"지만, 우리는 **앱 내부 패널**이라 다르다.

대신 Claude는 **자유 HTML이 아니라 검증된 JSON**을 뱉음. 그 JSON을 호스트의 React 컴포넌트(Heatmap, Tree, RoundCard 등)가 렌더.

- 트레이드오프: 새 시각화 종류 추가하려면 컴포넌트 구현 필요. 자유도는 줄지만 안정성·일관성이 큼.
- writer-tauri의 "Reliable / Wellmade" 원칙에 맞음.

### 6-2. 출력 스키마: 엄격한 Zod 검증

모든 mode 출력은 Zod 스키마로 검증. 검증 실패 = 자동 재시도 1회 + 실패 메시지. 이게 없으면 UI가 자주 깨짐.

### 6-3. 마크의 출처 추적

모든 Studio 발생 마크는 어느 아티팩트에서 왔는지 추적해야 함. `proofMarkSchemas.ts`의 `proofComment.attrs`와 `proofSuggestion.attrs`에 한 필드 추가:

```ts
sourceArtifactId: { default: null }
```

이게 있어야:
- 마크 클릭 → 원래 아티팩트로 돌아가기
- "이 Reader 페르소나가 만든 코멘트들" 필터링
- 나중에 Origin 히트맵이 mark 출처 집계할 때 재활용

**Phase 0에서 한 줄 추가**. 기존 문서 호환은 default null로 해결. 나중에 추가하기 비쌈.

### 6-4. 비용 관리: 캐싱

캐시 키 = `(docHash, modeId, paramsHash)`. 같은 글에 같은 파라미터로 또 누르면 캐시. 슬라이더 미세 조정 시 토큰 폭증 방지의 가장 큰 레버.

---

## 7. 단계적 도입 (4 phase)

### Phase 0 — 기반 (1~2주, 사용자에 보이는 기능 0)
- `src/studio/` 디렉토리 + Mode 인터페이스
- ContextExtractor (selection / document)
- ModeRunner (Claude 스트리밍 + Zod + 재시도)
- StudioPanel 빈 껍데기 + 헤더 탭
- markBridge — `proofSuggestion`/`proofComment`에 `sourceArtifactId` 추가
- artifactStore (인메모리 + 단순 캐시)

이 phase 끝나면 mode 추가는 각각 1주 이내.

### Phase 1 — Reverse Outline (가장 안전)
출력이 트리 + 카드라 시각화 컴포넌트 적음. 사용자 액션이 "근거 카드 → proofSuggestion(insert)"로 단순. 기존 sourceSlug 인덱스 재활용. Mode 추상화의 깔끔함이 검증되는 단계.

### Phase 2 — Reader Simulator (제일 복잡)
- 페르소나 라이브러리 (built-in 6개 + 사용자 커스텀)
- 멀티 페르소나 병렬 실행 (Promise.all + 비용 가시화)
- Heatmap 컴포넌트
- 페르소나 코멘트 → proofComment 매핑
- 캐싱이 본격 중요해지는 지점 (페르소나 N × 글 길이)

### Phase 3 — Argument Sparring (가장 동적)
- "라운드" 개념 도입 — artifactStore가 stateful
- 사용자 답변 입력 UI
- "토론 전체 흡수" → 다단계 proofSuggestion

가장 어려운 부분(stateful 라운드)을 마지막에 만나도록 의도적 배치. 그때쯤이면 1·2에서 학습한 패턴으로 깔끔하게 짤 수 있음.

---

## 8. 안 만들 것 (의도적 단순화)

- **iframe sandbox / 자유 HTML 입력**: 6-1에서 결정
- **아티팩트 영구 저장**: 휘발성. 본문의 마크가 영구 결과
- **여러 글 동시 비교**: v1은 현재 글 1개만. 멀티 doc은 v2
- **외부 LLM 다중화**: Claude 고정. mode 인터페이스는 LLM agnostic이지만 어댑터 1개
- **아티팩트 공유 (S3 업로드 등)**: 데스크탑 앱엔 불필요

---

## 한 줄 정리

> **Studio 프레임워크 + Mode 플러그인 + 호스트 React 컴포넌트 렌더 + proof 마크로 본문 anchor.**
> 새 기능은 Mode 1개 등록으로 추가되고, 본문은 항상 진실의 원천으로 남는다.
