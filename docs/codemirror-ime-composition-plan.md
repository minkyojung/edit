# CM 이주 — IME(조합 입력) 안전성 분석 (한글·일본어·중국어 등)

> 증상: 리스트에서 한글을 입력하고 **바로 Enter**를 누르면 새 리스트 항목이 안 생기고,
> 커서를 그 줄에 다시 두고 Enter를 누르면 생김. 이건 한글만의 문제가 아니라 **모든
> 조합형 입력(IME)** 공통 문제이며 정석 해법이 있다. 2026-06-05.
> 근거: CM6 IME 이슈(github.com/codemirror/dev#206), discuss.codemirror.net, 우리 코드.

## 1. 현상 / 재현
- 텍스트(한글) 입력 → **즉시 Enter** → 항목 안 생김 (조합이 Enter를 "확정"에 써버림)
- 텍스트 입력 → **커서 재배치(조합 확정)** → Enter → 정상 생성
- Obsidian(같은 CM6 기반)은 정상 → **우리 설정이 IME를 망가뜨리고 있다는 신호.**

## 2. 근본 원인 — 2층 구조

### 층 1) 브라우저 IME 기본 동작 (모든 에디터 공통)
- 조합 중에는 keydown이 **`isComposing === true` / `keyCode 229`(IME 처리 키)** 로 옴.
- 이 Enter는 **IME가 조합 확정용으로 소비**하고, 에디터 키맵까지 도달하지 않음 → 첫
  Enter는 글자만 확정, 줄바꿈/리스트 동작 안 함. (커서 이동 = 조합 확정 → 다음 Enter는
  정상 keydown)
- 정석: **조합 중 keydown으로 단축키를 실행하지 말고**, `compositionend` 이후 정상
  keydown을 처리. CM6은 이 조합 생명주기를 내부적으로 다룬다.

### 층 2) 우리가 IME를 악화시킨 부분 (← 진짜 우리 버그)
- 핵심: CM에서 **조합 중에는 조합 범위의 DOM이 흔들리면 안 된다.** CM6은
  `compositionend` 후 DOM에서 조합된 텍스트를 읽어가는데, 그 전에 확장이 커서 주변
  DOM(데코·위젯)을 바꾸면 조합이 깨지거나 멈춘다.
- 우리 데코 StateField들이 **매 변경마다 재빌드**한다:
  ```
  // livePreview.ts / mermaidCards.ts / mediaCards.ts
  update: (v, tr) => (tr.docChanged || tr.selection ? build(tr.state) : v)
  ```
  조합 중에도 `compositionupdate`마다 `docChanged` 트랜잭션이 떠서 **매 글자 데코 세트를
  다시 만들고 교체** → CM이 조합 줄을 다시 그리게 만들어 **조합이 불안정**해짐. 이게
  바닐라 CM/Obsidian보다 우리 첫-Enter가 더 잘 깨지는 직접 원인.

## 3. 다국어 관점 (한글만의 문제가 아님)
조합형 입력은 전부 동일 메커니즘:
- **한글**: 자모 조합(두벌식) — 음절이 확정 전까지 composition
- **일본어**: 카나→한자 변환 (가장 긴 composition)
- **중국어**: 병음→한자 후보 선택
- **그 외**: 데드키(é, ñ), 받아쓰기, 일부 이모지 선택기
→ 정석 해법은 "한글 특수 처리"가 아니라 **조합 생명주기를 존중하는 일반 해법**이어야 함.

## 4. 정석 해결 원칙
**"조합 중에는 조합 범위를 건드리지 않는다"** 가 핵심.
1. **조합 중 데코 재계산 금지**: `view.composing`(또는 트랜잭션
   `isUserEvent('input.type.compose')`)일 때는 데코 세트를 **이전 것 그대로 유지**하고,
   `compositionend` 후 한 번만 재빌드. → 조합 줄 DOM이 안정 → IME 정상.
2. **조합 줄에 위젯/원자 데코 금지**: 커서가 있는(=조합 중) 줄은 이미 reveal로 raw
   텍스트라 위젯이 없지만, **데코 세트 자체의 재생성/교체**가 문제이므로 (1)이 본질.
3. **키맵은 조합 후 Enter를 처리**: Enter 바인딩을 적절한 우선순위(`Prec.high`)로 두고,
   CM의 `compositionend` 후 정상 keydown 경로로 list-continue가 실행되게.

## 5. 우리에게 적용할 구체 방향 (구현 시)
- **A. 데코 필드를 조합-인지하게**: 각 StateField update에서 조합 중이면 재빌드 skip.
  StateField는 `view`가 없으므로:
  - 트랜잭션의 `tr.isUserEvent('input.type.compose')`로 조합 입력 감지 → skip, 또는
  - 작은 ViewPlugin이 `compositionstart/end`를 듣고 "조합 중" 플래그(StateEffect)를
    토글 → 필드가 그 플래그를 보고 조합 중엔 build 생략, end에 1회 rebuild.
  (CM 권장: 조합 중엔 데코를 바꾸지 말 것.)
- **B. reveal/selection 재빌드 억제**: 조합 중 `tr.selection`/`docChanged`로 인한
  재계산을 (A)로 함께 차단.
- **C. 검증**: IME는 헤드리스로 재현 불가 → 실제 Tauri 창에서 **한글/일어/중국어 각각**
  "입력 후 즉시 Enter로 리스트/문단 생성" 손검증. (자동 테스트는 조합 이벤트 시퀀스
  모킹이 한계라 보조)

## 6. 한 줄 결론
- **층1(브라우저 IME)** 은 모든 에디터 공통이고 CM6이 다룬다.
- **우리 버그는 층2** — 조합 중에도 데코를 매 입력 재빌드해서 조합 DOM을 흔든 것.
- 정석 = **조합 중 데코 재계산 중지 → compositionend 후 1회 재빌드** (다국어 공통).
- 이건 "리스트 Enter" 한 증상이 아니라 **모든 IME 입력 안정성의 근본**이라, 갭
  체크리스트 §G(안전장치)의 IME 항목으로 격상해 처리.
