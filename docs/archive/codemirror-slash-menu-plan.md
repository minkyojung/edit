# 이주 #2 — 슬래시 메뉴(`/`) CM 재설계 분석

> "동작 정의 → CM 정공법 → 공짜/커스텀 구분". 결론부터: CM의 정공법은
> **`@codemirror/autocomplete`**, 이걸 쓰면 PM의 트리거 플러그인 + zustand 스토어 +
> React 팝업 + 키보드 가로채기 해킹이 **통째로 증발**한다. 2026-06-05.
> 근거: `editor/slashTriggerPlugin.ts`, `slashItems.ts`, `SlashMenu.tsx`,
> `state/slashStore.ts`(현재) + `@codemirror/autocomplete@6.20.1`(CM 제공).

## 1. 우리가 원하는 동작 (현재 PM 코드에서 떠냄)

| # | 동작 |
|---|---|
| T1 | **트리거**: 텍스트블록 **맨 앞**에서 `/`(+ 쿼리 `/h1`). 문단 중간 X, 코드블록 안 X |
| T2 | IME 인지: 한글/일본어 조합 중엔 발화 안 함, 조합 끝나면 재평가 |
| F1 | 쿼리로 항목 필터 — label + keywords 둘 다 매칭(예: "todo"→To-do) |
| K1 | 키보드: ↑/↓ 이동, Enter 선택, Esc 닫기 — **에디터 포커스 유지** |
| R1 | 선택 시: 입력한 `/쿼리` 삭제 후 → 해당 변환/삽입 실행 |
| C1 | 항목 ~12개: Text, H1~3, 불릿/번호/할일 리스트, 인용, 코드, 구분선, 이미지(파일선택→볼트복사), GitHub 앵커 |
| P1 | 위치: `/`의 화면 좌표에 팝오버 |

## 2. CM 정공법 — `@codemirror/autocomplete`가 거의 다 공짜

CM의 자동완성은 **에디터 안 완성 UI 전용**으로 설계돼 있어, 우리가 PM에서 손으로 짠 걸 내장 제공한다.

| 원하는 동작 | CM 제공 | 비고 |
|---|---|---|
| P1 팝오버 + 커서 위치 | ✅ autocomplete tooltip | 위치/스크롤 자동 |
| K1 ↑/↓/Enter/Esc/Tab + **에디터 포커스 유지** | ✅ 내장 | **capture-phase 키보드 해킹 통째로 불필요** |
| F1 필터 | ✅ (label 기준) | keywords는 §3에서 소스가 직접 필터 |
| R1 `/쿼리` 삭제 후 적용 | ✅ `apply(view, completion, from, to)` | from/to가 매칭 범위 → 교체가 곧 "삭제+삽입" |
| 비동기/명시 트리거(Ctrl-Space) 등 | ✅ | 덤 |

핵심: `autocompletion({ override: [slashSource] })` + **CompletionSource 하나**가 PM의
트리거플러그인+스토어+React팝업+키보드해킹을 **대체**.

## 3. 따로 개발해야 하는 것 — 작고 명확

| 항목 | 내용 | 난이도 |
|---|---|---|
| **트리거 제한** | CompletionSource에서 `context.matchBefore(/\/[\p{L}\p{N}_]*/u)` + ①매치가 **줄 맨 앞**(`word.from === line.from`)인지 ②`syntaxTree`로 코드블록(FencedCode/CodeText) 안이 아닌지 확인. 아니면 null 반환 | 🟢 쉬움 |
| **키워드 필터** | 소스가 쿼리로 SLASH_ITEMS를 label+keywords 매칭해 직접 거른 뒤 `{from,to,options,filter:false}` 반환(CM 재필터 끄기) → 기존 필터 규칙 보존 | 🟢 쉬움 |
| **액션(apply) = 텍스트 편집** | PM 커맨드(setBlockType/wrapInList…) → **줄 prefix 텍스트 토글**(`# `,`- `,`- [ ] `,`> `, 펜스, `---`)로 재작성. 대부분 한 줄 | 🟢 쉬움 |
| 아이콘 | CM 기본은 type 아이콘. @tabler 아이콘 그대로면 completion `render` 커스텀(선택). 미루기 가능 | 🟡 보통(선택) |
| IME(T2) | CM autocomplete가 조합을 어느 정도 다룸 → **검증 후** 필요 시 보강 | 검증 항목 |

→ **진짜 작업은 "CompletionSource 1개(트리거+필터) + 액션을 텍스트 편집로"** 가 거의 전부.

## 4. 재사용 (거의 그대로)

- `slashItems.ts` **카탈로그 데이터**(id/label/keywords/icon) — 그대로. `run`만 PM커맨드→텍스트편집로 교체.
- 이미지/GitHub 액션의 **앱 로직**(`copyImageIntoVault`, `insertGitHubAnchor`, 파일 다이얼로그) — 재사용, 끝의 "삽입"만 텍스트로.

## 5. 증발하는 PM 코드

- `slashTriggerPlugin.ts`(트리거 감지+coords+스토어 push) → CompletionSource ~20줄로 대체.
- `state/slashStore.ts`(zustand 브리지) → 불필요(CM이 팝업 상태 소유).
- `SlashMenu.tsx`(React 팝업 + **capture-phase 키보드 가로채기** + 위치계산) → CM 내장 팝업으로 대체. **가장 큰 삭제** — "에디터 포커스 유지하며 키 가로채기" 해킹이 통째로 사라짐(CM이 정확히 이걸 위해 설계됨).

## 6. 검증 (③) — 전부 헤드리스 단위테스트 가능

CompletionSource는 `source(new CompletionContext(state, pos, explicit))` 호출로 검증:
- 줄 맨 앞 `/` → 옵션 반환 / 문단 중간 `/` → null / 코드블록 안 → null
- `/todo` → To-do 항목이 keywords 매칭으로 떠오름
- `apply` 실행 시 `/쿼리`가 삭제되고 마커가 삽입(`/h1`→`# `)되는지
- 빈 `/` → 전체 목록

## 7. 보너스 — 위키링크와 한 패턴

`[[`로 뜨는 **위키링크 자동완성도 동일한 CompletionSource 패턴**이라, 여기서 만든 토대를
그대로 재사용. 슬래시(#2)를 정공법으로 잡으면 위키링크(#3)의 자동완성 절반이 같이 풀림.

## 8. 작업 순서 / 공수 (감)

1. `@codemirror/autocomplete@6.20.1` 직접 의존성 추가.
2. CompletionSource(트리거 제한 + 키워드 필터) + 텍스트-편집 액션 작성.
3. 헤드리스 테스트(§6) → 프로토타입에 `autocompletion({override})` 얹고 손 검증.
4. (선택) 아이콘 커스텀 render, IME 보강.

- 합계 대략 **1.5~2일**. 리스크 낮음, 코드량은 PM 대비 **대폭 감소**(스토어+팝업+해킹 삭제).

## 요약
- **CM 공짜**: 팝업·위치·키보드(↑↓/Enter/Esc)·포커스 유지·`/쿼리` 교체 적용.
- **커스텀(작음)**: CompletionSource(줄앞+코드블록 제외 트리거 + 키워드 필터), 액션을 텍스트편집로.
- **증발**: slashTriggerPlugin + slashStore + SlashMenu(키보드 해킹 포함).
- **재사용**: 항목 카탈로그, 이미지/GitHub 액션 로직. + 위키링크가 같은 패턴.

## 9. 구현 결과 (2026-06-05 실측 — 8/8 통과)

`prototypes/slashCommands.ts`(SLASH_ITEMS 11개 + `slashSource` + `slashMenu=
autocompletion({override})`) + `slashCommands.test.ts`. `@codemirror/autocomplete@
6.20.1` 추가, 프로토타입 배선.

| 검증 | 결과 |
|---|---|
| 줄 맨 앞 `/` → 전체 목록 | ✅ |
| 문단 중간 `/`(예 "hello /x") → null | ✅ |
| 코드블록 안 `/` → null | ✅ |
| `/h1` → Heading 1 | ✅ |
| `/todo` → To-do(키워드 매칭) | ✅ |
| 매치 없음 → null(팝업 안 뜸) | ✅ |
| apply: `/h1`→"# ", `/todo`→"- [ ] " | ✅ |

- **CompletionSource ~30줄 + 텍스트-편집 액션이 전부.** 팝업/키보드/포커스/위치는 CM 내장.
- PM의 slashTriggerPlugin·slashStore·SlashMenu(키보드 해킹 포함)는 **이주 시 통째로 폐기.**
- 팝업 UI 자체는 CM stock이라 `/` 입력 시에만 표시 → 실 브라우저 손확인. 소스 로직은
  헤드리스 8/8로 증명. 전체 330 테스트 green.
- 다음 #3(위키링크 `[[`)은 **동일 CompletionSource 패턴** 재사용.
