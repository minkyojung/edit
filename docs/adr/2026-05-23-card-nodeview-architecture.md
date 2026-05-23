# ADR: 카드 NodeView 아키텍처 — 이미지·영상·오디오 통합 모델

작성: 2026-05-23
상태: **Accepted**

---

## Context

writer-tauri 의 에디터에 미디어 (이미지 / 영상 / 오디오) 를 본문에 끼우는 작업을 하면서, ProseMirror + Milkdown + WKWebView (Tauri) 조합 특유의 함정이 여러 번 드러났다. 이 ADR 은 그 함정을 따라가며 도달한 **단일 카드 패턴** 의 형태와 그 선택의 이유를 기록한다.

### 시도 1 — schema.draggable=true + native `<video controls>` (실패)

가장 단순한 접근. `imageBlock` / `videoBlock` 을 `atom: true, draggable: true` 로 정의하고 NodeView 는 `<video controls>` 로 렌더. PM 의 schema-driven auto-drag 가 자동으로 카드 이동을 처리.

**깨진 이유**: 이미지 카드는 동작했지만 영상 카드에서 **재생바·볼륨 슬라이더 조작 → 카드 전체가 따라 움직임**. 사용자가 시킹하려고 thumb 을 잡으면 카드가 드래그됨.

원인: `<video controls>` 의 native UI 는 user-agent shadow DOM 안에 있고, 그 안의 scrubber 가 발생시키는 pointer event 가 PM 의 `mightDrag` 트랩에 잡힘. PM 은 atom 노드 (`spec.draggable` 이 true) 에 대해 mousedown 순간 figure 의 `draggable` 속성을 일시적으로 true 로 만들고, 브라우저는 그 ancestor 를 드래그 origin 으로 잡음.

### 시도 2 — figure.draggable=false + JS 우회 (실패 누적)

shadow DOM 충돌을 막으려고 figure 의 native draggable 을 끄고, 카드 좌측 마진에 invisible 핸들 버튼을 두고 그 위에서만 dragstart 받게 함. 추가로 stopEvent / -webkit-user-drag CSS / body 의 dragstart swallow 같은 여러 패치 시도.

**깨진 이유**: 각 패치가 다른 패치를 깨뜨림.
- `figure.draggable = false` → PM 의 mightDrag 가 mousedown 때 다시 true 로 덮어씀
- body 의 dragstart 를 capture-phase 로 swallow → 영상 컨트롤 shadow DOM 에서 발생한 dragstart 는 composed 가 아니라 외부로 안 새 → swallow 못 잡음
- `-webkit-user-drag: none` 으로 figure 차단 → 핸들도 같이 죽음
- 선택 상태에서만 stopEvent 분기 (Substack 식 두-동작) → 한 동작 드래그 UX 죽음, 그리고 선택 상태에서 scrubbing 시 같은 충돌 재발

**구조적 진단**: 한쪽을 막으면 다른 쪽이 깨지는 도돌이. 근본 원인은 **PM 의 single-contenteditable + 글로벌 이벤트 리스너 모델** 과 **WKWebView 의 shadow DOM event composition 동작** 의 조합. JS 레벨 패치로는 못 닫음.

### 시도 3 — Custom controls + atom-default draggable (성공)

`<video controls>` 의 controls 속성을 빼고 우리 자체 컨트롤 UI 를 plain DOM 으로 렌더. shadow DOM 자체를 제거하니 위 모든 충돌 source 가 사라짐.

PM 의 자연 경로를 다시 활용:
- schema 의 `atom: true` 가 `spec.draggable` 을 기본 true 로 만듦 (PM 공식 default)
- mousedown on body → PM 의 mightDrag 가 figure.draggable=true 임시 부여 → 자연스럽게 카드 드래그 시작
- 우리는 dragstart 에 hook 만 걸어서 WKWebView 의 합성 레이어 누수만 막는 **canvas 기반 drag preview** 만 override

영상 컨트롤 (재생 버튼, 시킹바, 볼륨 등) 각각이 자기 이벤트에 `stopPropagation` → PM 의 input pipeline 에 도달 안 함 → 카드 드래그 안 트리거. **컨트롤 영역과 body 영역이 각자 자기 역할만** 함.

---

## Decision

### 카드 = atom NodeView + 내부 shadow DOM 없음

모든 카드 타입 (`imageBlock` / `videoBlock` / `audioBlock`) 은 동일한 구조:

```
<figure data-card="<type>" contenteditable="false">
  <body element(s)>     ← 매체별 (img / video / audio + 우리 controls)
</figure>
```

PM 책임:
- schema 의 `atom: true` 가 `spec.draggable` 을 기본 true 로 → 자동 드래그 진입
- mousedown → mightDrag → figure.draggable 임시 true → 드래그 시작
- dragstart → PM 이 NodeSelection / serializeForClipboard / dataTransfer / view.dragging 모두 처리

우리 NodeView 의 책임:
- canvas 기반 drag preview (WKWebView 합성 레이어 누수 방지)
- 매체별 body 렌더 (`renderBody`) + 업데이트 (`updateBody`)
- contenteditable=false (atom selection 격리)

### BaseCardNodeView 추상 클래스

`cards/BaseCardNodeView.ts` 가 위 책임을 한 곳에서 제공. 각 카드는 상속해서 `renderBody` / `updateBody` 만 구현 (~50~100줄).

| 카드 | body 구성 |
|---|---|
| `ImageCardNodeView` | `<img>` 하나 |
| `VideoCardNodeView` | `<video>` (controls off) + `createMediaControls(video, ...)` |
| `AudioCardNodeView` | title input + 숨겨진 `<audio>` + `createMediaControls(audio, ...)` |

### Custom media controls

`cards/MediaControls.ts` 가 `HTMLMediaElement` (video + audio 부모 클래스) 위에서 동작하는 단일 컴포넌트. 영상과 오디오가 동일한 시킹바·재생 버튼·시간·볼륨 UI 를 공유. 각 컨트롤은 자기 이벤트에 `stopPropagation` → PM 의 mightDrag 가 안 발동.

variant 차이는 className 으로:
- `video-controls`: absolute overlay + 그라데이션 배경 + auto-hide (hover/paused 시만 보임)
- `audio-controls`: in-flow solid bar + 항상 보임

### 마크다운 round-trip

| 매체 | 마크다운 표현 | 라운드트립 경로 |
|---|---|---|
| 이미지 | `![alt](images/foo.jpg)` | CommonMark 표준 + post-parse unwrap |
| 영상 | `<video src="videos/clip.mp4" controls></video>` | mdast `html` ↔ raw HTML, regex 매처로 audio 와 분리 |
| 오디오 | `<audio src="audio/voice.mp3" title="..." controls></audio>` | 동일 패턴, `title` attr 에 사용자 설명 저장 |

영상·오디오는 CommonMark spec 에 없으므로 raw HTML 사용 — vim/grep 가독성 유지 + GitHub 에선 그대로 텍스트로 보임. Obsidian 호환은 미흡하지만 외부 도구 호환 우선.

### contenteditable=true 내부 wrapper (오디오 한정)

오디오 카드의 title input 은 atom NodeView 안에 있어 WebKit 의 알려진 quirk 에 걸림:

> `<input>` 가 contenteditable=false 조상 안에 있으면 WebKit 은 키 입력을 거부함.

해결: input 만 작은 `<div contenteditable="true" class="audio-title-host">` 로 감쌈. WebKit 이 input 입력을 허용 + PM 은 atom 내부를 traverse 안 하므로 영향 없음. tiptap / Lexical 의 reactNodeView 가 React 컴포넌트 mount 할 때 자동으로 하는 것과 같은 패턴.

추가로 `stopEvent(event)` 가 input host 안 이벤트를 PM 처리에서 제외 — focus / mousedown / 키보드가 PM 의 selectionchange 동기화에 안 잡힘.

---

## Consequences

### 좋아진 것

- **단일 카드 패턴** 으로 미디어 추가 비용 감소. PDF / 링크 카드 / AI 답변 카드 등이 같은 BaseCardNodeView 위에 ~100~200줄로 붙음.
- 드래그·드롭·셀렉션 같은 PM 핵심 동작이 우리 코드 우회 없이 자연 경로로 흐름 → 회귀 위험 ↓
- shadow DOM 충돌의 가능성 자체가 제거됨 — 미래의 모든 native HTML5 control (video / audio / 미래 input/canvas 기반 위젯) 에서 같은 함정 안 겪음.

### 잃은 것

- native `<video controls>` / `<audio controls>` 의 OS-level fullscreen UI 사용 불가. 우리 custom controls 가 fullscreen 지원 안 함 (시도했으나 WKWebView 의 fullscreen API 가 InvalidStateError 던짐 — Tauri WebView config 한정 이슈로 판단).
- 접근성 측면에서 native controls 가 기본 제공하는 키보드 단축키 / 스크린리더 alert 등을 직접 처리해야 함. 현재 미구현, 필요해지면 별도 작업.

### 미래의 함정 / 주의점

- **`view.dragging` / `view.serializeForClipboard` 같은 PM 내부 API** 에 직접 의존하는 코드는 없음 (시도 2 에서 시도했다가 제거). 이건 의도된 선택 — PM 메이저 버전 업그레이드 시 안정성을 위해.
- **canvas drag preview** 는 `HTMLImageElement` / `HTMLVideoElement` 에만 동작 (drawImage 지원). 다른 source (audio) 는 BaseCardNodeView 가 자동으로 clone-fallback. 미래의 카드 타입이 시각적 source 가 없으면 fallback 그대로.
- **WebKit 의 contenteditable=false + input** 우회는 오디오 카드에서 처음 등장. 미래에 다른 카드가 내부에 input / textarea 를 가지면 같은 패턴 (`<div contenteditable="true">` wrapper + stopEvent) 적용해야 함.
- **마크다운 round-trip 의 raw HTML 매처** 는 정규식 기반. 매우 비정상적인 HTML (예: 속성 순서 이상함, 따옴표 escape 깨짐) 은 못 잡을 수 있음. 일반적인 우리 출력 / Obsidian / VS Code 같은 외부 도구의 출력은 모두 cover.

### Critical files

- `apps/writer-tauri/src/editor/cards/BaseCardNodeView.ts` — 추상 클래스 (wrapper, drag preview, selection chrome)
- `apps/writer-tauri/src/editor/cards/MediaControls.ts` — 영상·오디오 공유 컨트롤 UI (HTMLMediaElement 위에서 동작)
- `apps/writer-tauri/src/editor/cards/ImageCardNodeView.ts` / `VideoCardNodeView.ts` / `AudioCardNodeView.ts` — 매체별 NodeView
- `apps/writer-tauri/src/editor/schema/image-block.ts` / `video-block.ts` / `audio-block.ts` — atom schema (PM auto-drag 활용, `draggable` 명시 안 함)
- `apps/writer-tauri/src/editor/mediaDropPastePlugin.ts` — image/video/audio MIME 분기 단일 plugin
- `apps/writer-tauri/src/editor/cardDropAdvanceCursor.ts` — drop 후 cursor 자동 진행
- `apps/writer-tauri/src/editor/insertBlock.ts` — generic block atom 삽입 헬퍼
- `apps/writer-tauri/src/editor/utils/resolveVaultAssetSrc.ts` — vault-relative path → asset:// URL
