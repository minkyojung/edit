# 이주 #1 — 편집 손맛(리스트/제목/들여쓰기) CM 재설계 분석

> "기존 PM 코드를 베끼지 말고, ①원하는 동작 정의 → ②CM 정공법 → ③검증"으로 가는
> 첫 플러그인. 무엇이 CM 기본 제공이고 무엇을 따로 만들지 가른다. 2026-06-05.
> 근거: `editor/listKeymap.ts`, `headingKeymap.ts`, `taskList.ts`, `inlineCodeSafe.ts`
> (현재 동작) + `@codemirror/lang-markdown@6.5.0`, `@codemirror/commands`(CM 제공).

## 1. 우리가 원하는 동작 (현재 PM 코드에서 떠낸 사양)

| # | 상황 | 원하는 동작 |
|---|---|---|
| L1 | 리스트 항목에서 Enter | 같은 종류 새 항목 (번호면 자동증가) |
| L2 | **빈** 리스트 항목에서 Enter | 리스트 탈출(일반 문단으로) — Notion/Bear/Linear식 |
| L3 | 태스크(`- [ ]`)에서 Enter | 새 **빈 체크박스** 항목(체크 안 됨) |
| L4 | 빈 리스트 항목 시작에서 Backspace | 그 자리서 일반 문단으로(마커만 제거) |
| L5 | **Tab / Shift+Tab** | 리스트 항목 **들여쓰기 / 내어쓰기**(번호리스트 재넘버링) |
| H1 | 제목 끝에서 Enter | 아래에 **일반 문단**(또 제목 X) |
| H2 | 제목 중간에서 Enter | 제목은 앞부분만, 뒷부분은 아래 문단으로 분리 |
| F1 | 굵게/기울임/인라인코드 토글 | 선택 영역 감싸기 (단축키 + 툴바/슬래시) |
| B1 | "리스트로 / 체크리스트로 / 제목으로 만들기" | 블록 변환 명령(슬래시·툴바가 호출) |

## 2. CM 정공법으로 처리 — 거의 공짜

`markdown({ addKeymap: true })`(기본값)가 **markdownKeymap**을 깔아주고,
`@codemirror/commands` + history가 나머지를 덮는다.

| 원하는 동작 | CM 메커니즘 | 비고 |
|---|---|---|
| L1 새 항목·번호 자동증가 | `insertNewlineContinueMarkup` (Enter) | 기본 제공 |
| L2 빈 항목 Enter → 탈출 | `insertNewlineContinueMarkup` | 빈 항목이면 마커 제거 |
| L4 Backspace 마커 제거 | `deleteMarkupBackward` (Backspace) | 기본 제공 |
| H1/H2 제목 Enter → 문단 | **CM 기본 Enter** | 제목은 그냥 `#`로 시작하는 한 줄 → Enter로 만든 새 줄은 `#`이 없으니 **자동으로 일반 문단**. PM의 headingKeymap이 **통째로 불필요** |
| undo/redo·기본 들여쓰기 유지 | `history`, `indentOnInput` | 기본 제공 |

→ **L1·L2·L4·H1·H2 = 사실상 공짜.** (제목 동작이 통째로 증발하는 게 가장 큰 단순화)

## 3. 따로 개발해야 하는 것 — 양이 적음

| 항목 | 왜 커스텀 | 난이도 | 설계 메모 |
|---|---|---|---|
| **L5 Tab/Shift+Tab 들여쓰기** | markdownKeymap에 Tab 바인딩 **없음**(확인됨). 마크다운 리스트 들여쓰기는 CM 공통 빈틈 | 🟡 보통 | Tab=리스트 줄의 선행 공백 한 단계 추가, Shift+Tab=제거. 번호리스트면 형제 항목 재넘버링. 커서가 리스트 밖이면 기본 Tab으로 위임 |
| **F1 서식 토글** | markdownKeymap에 bold/italic/code 토글 없음 | 🟢 쉬움 | 선택을 `**`/`*`/`` ` ``로 감싸기/풀기. **proof-mark 보존 걱정은 사라짐**(CM에선 proof마크=데코지 텍스트마크 아님 → inlineCodeSafe의 복잡성 불필요) |
| **B1 블록 변환** | 도메인 명령 | 🟢 쉬움 | 줄 앞에 `- `/`- [ ] `/`#` 붙이거나 제거. 텍스트 조작이라 단순 |

→ **진짜 새 작업은 사실상 L5(Tab 들여쓰기) 하나가 중심**, F1·B1은 짧은 텍스트 명령.

## 4. 증발하는 PM 코드 (재설계로 사라짐)

- `headingKeymap.ts` 전체 — CM 기본 Enter로 충분.
- `listKeymap.ts`의 Enter/Backspace 대부분 — `insertNewlineContinueMarkup`/
  `deleteMarkupBackward`가 대체. (L3 태스크 Enter만 검증 후 필요 시 미세 보강)
- `inlineCodeSafe.ts`의 "proof-mark 보존" 로직 — proof마크가 텍스트마크가 아니라 불필요.
- `taskList.ts`의 노드-attr(`checked`) 조작 — CM에선 `- [ ] ` 텍스트라 attr 개념 없음.
- `listItemConfig.ts` — milkdown 컴포넌트 렌더 설정, CM에선 N/A.

## 5. 반드시 검증할 항목 (③ 검증 단계)

CM 기본 동작이 "우리가 원하는 그대로"인지 시나리오 테스트로 확인:
- L3: 태스크 항목 Enter가 **빈 체크박스**(체크 안 됨)로 이어지는가? (CM이 처리할 가능성
  높으나 미니파이 코드로 단정 불가 → 테스트로 확정. 아니면 Enter 커스텀 한 줄 보강)
- L2: 빈 항목 Enter가 **완전 탈출**(중첩이면 한 단계만 빠지는지 등) 우리 기대와 일치?
- L1: 번호리스트 Enter 시 번호 자동증가가 우리 표기와 맞는지.
- 헤딩 중간 Enter(H2)가 "앞=제목 / 뒤=문단"으로 갈리는지.

## 6. 작업 순서 / 공수 (감)

1. CM 기본 동작 시나리오 테스트부터 작성 → L1/L2/L3/L4/H1/H2가 어디까지 공짜인지 **측정**.
2. 빈틈만 커스텀: **L5 Tab 들여쓰기**(중심) → F1 서식 토글 → B1 블록 변환.
3. 프로토타입에 키맵 얹고 손 검증.

- 합계 대략 **2~3일**. 리스크 낮음(L5만 약간 손이 감), 나머지는 CM 기본 + 짧은 명령.

## 요약
- **CM 공짜**: 리스트 Enter/Backspace 마커 처리, 제목 Enter(→문단), undo/들여쓰기.
- **커스텀(적음)**: Tab 리스트 들여쓰기(중심), 서식 토글, 블록 변환.
- **증발**: headingKeymap 전체 + listKeymap 대부분 + inlineCodeSafe 복잡성 + taskList attr.
- 정공법 재설계 = "기존 4파일을 옮긴다"가 아니라 **"CM 기본을 측정해 빈틈만 짧게 채운다."**

## A단계 측정 결과 (2026-06-05 실측 — 9/9 통과)

프로토타입에 stock 명령 배선(`CodeMirrorPreview.tsx`: Enter=insertNewlineContinueMarkup,
Backspace=deleteMarkupBackward, indentWithTab, indentUnit 2칸) + 시나리오 테스트
(`editingBehavior.test.ts`)로 측정. **전부 CM 기본으로 동작 = 추가 개발 0**:

| 동작 | 결과 |
|---|---|
| L1 불릿 Enter → 새 항목 | ✅ `- item` → `- item\n- ` |
| L1 번호 Enter → 자동증가 | ✅ `1. item` → `1. item\n2. ` |
| L2 빈 항목 Enter → 리스트 탈출 | ✅ 마커 제거 |
| L3 태스크 Enter → **빈 체크박스** | ✅ `- [ ] task` → `…\n- [ ] ` (검증 항목이었음) |
| L3b 체크된 항목 Enter → 다음은 unchecked | ✅ |
| H1/H2 제목 Enter → 일반 문단 | ✅ continueMarkup이 false 반환 → 기본 Enter가 평문 처리 |
| L4 Backspace → 마커 제거 | ✅ `- item`(커서 본문 시작) → `item` |
| **L5 Tab/Shift+Tab 들여쓰기** | ✅ `indentMore`/`indentLess`로 `- item` ↔ `  - item` |

→ **놀라운 결과: §1 사양 전체(L1~L5, H1~H2)가 CM stock으로 공짜.** 커스텀 키맵 불필요.
PM의 listKeymap/headingKeymap/taskList/inlineCodeSafe(편집 키 부분)는 **이주 시 통째로
버려도 됨.** 전체 322 테스트 green.

### 남은(미룬) 것 — 핵심 타이핑과 무관, 나중에 하나씩
- **B 번호리스트 재넘버링**: indentMore는 공백만 추가(형제 번호 자동정리 X). 디테일.
- **C 서식 토글**(Cmd+B/I/code): markdownKeymap에 없음 → 선택 감싸기 짧은 명령.
- **D 블록 변환**(제목/리스트/체크리스트로): 줄 앞 마커 토글 짧은 명령. 슬래시·툴바용.
