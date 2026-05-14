# Markdown Styling — 구현 계획

작성: 2026-05-09
업데이트: 2026-05-10
상태: Phase 1 / 1.5 / 2 완료. 링크 hover bar Edit/데드 존 마무리. 신뢰성 인프라 + ESLint 도입. 다음 우선순위 미정 (§13.8)

---

## 0. 배경

writer-tauri 에디터(Milkdown + ProseMirror, CommonMark/GFM)에는 현재
포맷 토글 UI가 없다. 사용자는 마크다운을 직접 타이핑하거나
키보드 단축키 없이 작업하고 있다. proofMark(AI 제안/코멘트) 시스템은
이미 셀렉션 위에 floating `MarkToolbar`로 노출되고 있으며, 새 포맷 UI는
**이 시스템과 충돌하지 않으면서** 추가되어야 한다.

## 1. 목표

- 마크다운 포맷팅(B/I/S/Code/Link, 제목, 리스트, 인용 등)을 키보드와
  마우스 양쪽으로 쉽게 적용한다.
- 라이팅 흐름을 방해하지 않는다 (Notion보다 iA Writer/Bear에 가까운 톤).
- proofMark UX와 책임/위치/트리거가 명확히 분리된다.
- 최소 스펙으로 시작해 사용 후 조정·확장한다.

## 2. 디자인 원칙

1. **Discoverable but invisible** — 글 쓸 때 시야에서 사라지고, 필요할 때
   즉시 잡힌다.
2. **Keyboard-first** — 모든 액션은 단축키 또는 마크다운 입력 룰로
   접근 가능하다. 툴바는 보조 채널.
3. **One intent, one surface** — 포맷 / proofMark 액션 / 블록 변환은
   각자 다른 표면(static toolbar / floating bubble / slash menu)을 갖는다.
4. **proofMark 불가침** — 새 포맷 mark는 schema·시각·위치에서 proofMark과
   절대 충돌하지 않는다.
5. **Calm canvas** — 블록 핸들(+ / ⋮⋮)은 도입하지 않는다.

## 3. 책임 분리

| 표면 | 담당 | 트리거 |
|---|---|---|
| 정적 포맷 툴바 (Row 2) | 인라인 포맷, 블록 스타일 변환 | 항상 표시, 셀렉션 활성 상태 토글 |
| 셀렉션 버블 (`MarkToolbar`, 기존) | proofMark 액션 (Comment / Suggest) | 비어있지 않은 셀렉션 |
| 슬래시 메뉴 (`/`, Phase 2) | 블록 삽입/변환 카탈로그 | 라인 시작 또는 빈 노드에서 `/` 입력 |
| 마크다운 입력 룰 | 자동 변환 (`# `, `**x**`, `- ` 등) | 타이핑 중 자동 |

## 4. 헤더 재배치

### 현재
```
Row 1 [traffic-light] [sidebar?] [Breadcrumb + collab status] [drag] [더보기] [우측 사이드바]
Row 2 [탭 strip ...]                                              [+ 새 문서]
```

### 변경 후
```
Row 1 [traffic-light] [sidebar?] [탭 strip ...] [+ 새 문서] [drag] [collab] [더보기] [우측 사이드바]
Row 2 [Style ▾] [B] [I] [S] [</>]  |  [↗ Link]  |  [≡ List ▾]
```

### 변경 사항
- `Breadcrumb` 제거 (탭이 식별자 역할 대체)
- collab 상태 라벨은 우측 actions 직전으로 이동 — 끊겼을 때 잘 보이는 자리
- 탭 strip을 Row 1로 이식. Row 1의 `flex-1` drag region은 탭 다음 + actions 앞에
  유지 (Tauri 윈도우 드래그 영역 보존)
- Row 2 = 신규 `FormatToolbar` (h: --header-h 그대로)

### 위험 / 검토 포인트
- traffic-light(5rem spacer)와 첫 탭 간격 확인
- 탭 strip은 `overflow-x-auto` 그대로 유지 → 많아지면 스크롤
- collab 상태 칩이 더보기/우측사이드바 버튼과 시각적으로 무겁지 않은지

---

## 5. Phase 1 — 최소 스펙

목표: **포맷 토글 + 마크다운 단축키**까지. 슬래시 커맨드는 Phase 2로.

### 5.1 EditorHeader 재구성
- `Breadcrumb` 제거
- collab 상태 라벨을 우측 actions 직전으로 이동
- `EditorTabs`를 Row 1 가운데에 마운트
- 기존 Row 2(탭 자리)는 비움 → `FormatToolbar` 마운트

### 5.2 FormatToolbar (신규)
**위치**: Row 2, height `--header-h`, `border-b`로 본문과 분리

**구성** (최소, 좌→우, `|` = `Separator`):
- `Style ▾` — DropdownMenu: Text / H1 / H2 / H3 / Quote / Bullet list / Numbered list
- `|` `B` `I` — Toggle (toggle group)
- `|` `↗ Link` — 클릭 시 mini Popover로 URL 입력

확장 후보 (Phase 1.5, 사용 후 추가):
- `S` (strike), `</>` (inline code), 별도 List 드롭다운, Code block 토글

**상태**:
- 항상 표시 (사라지지 않음)
- 현재 셀렉션의 active mark / active block에 따라 토글 highlight
- 셀렉션이 비어 있어도 클릭 가능 → 다음 입력에 마크 적용 (`toggleMark`)

**구현 토대**:
- shadcn: `Toggle`, `Separator`, `Tooltip`, `DropdownMenu`, `Popover`
- ProseMirror 명령: `toggleMark`, `setBlockType`, `wrapIn`, `lift`
- 셀렉션 추적: 기존 `selectionPlugin` 활용 (already exposes `from`/`to`/`text`/`coords`)
- active mark 판정: `view.state.doc.rangeHasMark(...)` + `markActive()` 헬퍼 신규 추가

### 5.3 키보드 단축키
- `Cmd+B` — bold
- `Cmd+I` — italic
- `Cmd+Shift+S` — strike
- `Cmd+E` — inline code
- `Cmd+K` — link (mini popover 오픈)

Milkdown commonmark preset의 keymap이 일부 제공할 수 있음 → 인벤토리 후
빠진 것만 추가.

### 5.4 마크다운 입력 룰
검증/보강 대상:
- `# `, `## `, `### ` → H1/H2/H3
- `- `, `* ` → bullet list
- `1. ` → ordered list
- `> ` → blockquote
- ` ``` ` → code block
- `**x**` → bold
- `*x*`, `_x_` → italic
- `` `x` `` → inline code
- `~~x~~` → strikethrough
- `---` → divider

→ commonmark/gfm preset 인벤토리 먼저, 빠진 것만 inputRule 추가.
Esc / Cmd+Z 취소 보장 필수.

### 5.5 기존 시스템 무변경 확인
- `MarkToolbar` (셀렉션 버블, Comment/Suggest) — 그대로
- proofMark schema (proofSuggestion, proofComment, ...) — 그대로
- 새 포맷 mark는 commonmark preset의 표준 mark만 사용 (custom mark 추가 0)

---

## 6. Phase 2 — 슬래시 커맨드

목표: `/` 입력으로 블록 변환/삽입 메뉴 호출.

### 트리거 / UX
- 라인 시작 또는 빈 노드에서 `/` 입력 시 popover 오픈
- 검색어: `/` 뒤 입력 텍스트로 fuzzy filter
- 키보드: ↑↓ 이동, Enter 실행, Esc 취소

### 카탈로그 (초안)
- **Style**: Text, H1, H2, H3, Bullet/Numbered/Todo, Quote, Code, Divider
- **Insert**: Wikilink (`[[`와 별도 진입점), Image
- **AI** (선택): 채팅 패널과 역할 분리 후 결정

### 구현 토대
- ProseMirror plugin: 트리거 감지 + 커서 좌표 노출
- shadcn: `Command`(cmdk) inside `Popover`
- frozen selection 패턴 활용 (popover 포커스로 셀렉션 잃지 않게)

---

## 7. Phase 3 (옵션)

- 추가 인라인: highlight, subscript/superscript
- 링크 마크 hover preview
- 셀렉션 시 색상/하이라이트 토글 (Notion 스타일)
- 사용 데이터 보고 결정

---

## 8. proofMark 친화 검증 (Phase 1에서 반드시)

| 검증 | 방법 |
|---|---|
| 표준 mark(bold/italic/code)가 proofSuggestion과 같은 range에 공존 가능 | schema `excludes` 확인 + 수동 테스트 |
| inclusive 동작 (bold는 inclusive=true 기대) | 경계에서 입력 테스트 |
| 마크다운 라운드트립 시 포맷 mark 보존, proofMark은 dormant 유지 | 서버 동기화 후 reload 테스트 |
| Yjs 동기화에서 새 mark가 누락 없이 전파 | 두 클라이언트로 협업 테스트 |
| Row 2 정적 툴바와 셀렉션 버블이 동시 활성일 때 시각 충돌 없음 | 셀렉션 상태로 수동 확인 |

---

## 9. 비결정 / 후속 결정 항목

- Style 드롭다운과 List 드롭다운의 항목 중복 처리 (둘 다 둘지, 합칠지)
- collab 상태 칩의 시각 디자인 (텍스트 vs 아이콘 dot)
- Phase 2 슬래시 메뉴 AI 카테고리 포함 여부
- Link mini popover의 동작 (Enter로 적용 / preview / unlink 버튼 위치)

---

## 10. 작업 순서 (Phase 1)

1. Milkdown commonmark/gfm preset의 input rules / keymap 인벤토리 (0.5d)
2. proofMark schema 공존 검증 테스트 (0.5d)
3. EditorHeader 재구성 PR (1d)
4. FormatToolbar 컴포넌트 + 셀렉션 active 상태 추적 (1.5d)
5. 키보드 단축키 + 빠진 input rule 보강 (0.5d)
6. 수동 QA (proofMark, 협업, 라운드트립) (0.5d)

총 ~4.5일 추정.

---

## 11. Preset 인벤토리 (2026-05-09 조사)

조사 대상: `@milkdown/preset-commonmark@7.20.0`, `@milkdown/preset-gfm@7.20.0`
(현재 `MilkdownEditor.tsx:172-173`에서 둘 다 활성화됨)

### 11.1 Inline 마크

| 마크 | Schema | InputRule | Keymap | 토글 명령 |
|---|---|---|---|---|
| **strong** (bold) | ✅ commonmark | ✅ `**x**`, `__x__` | ✅ `Mod-b` | `toggleStrongCommand` |
| **emphasis** (italic) | ✅ commonmark | ✅ `*x*`, `_x_` | ✅ `Mod-i` | `toggleEmphasisCommand` |
| **inlineCode** | ✅ commonmark | ✅ `` `x` `` | ✅ `Mod-e` | `toggleInlineCodeCommand` |
| **link** | ✅ commonmark | ❌ | ❌ | `toggleLinkCommand({href, title})`, `updateLinkCommand` |
| **strike_through** | ✅ gfm | ✅ `~x~`, `~~x~~` | ✅ `Mod-Alt-x` | `toggleStrikethroughCommand` |

### 11.2 블록 노드

| 노드 | Schema | InputRule | Keymap | 명령 |
|---|---|---|---|---|
| **paragraph** | ✅ | (기본) | ✅ `Mod-Alt-0` | `turnIntoTextCommand` |
| **heading** (level 1~6) | ✅ | ✅ `# ` `## ` ... `###### ` | ✅ `Mod-Alt-1` ~ `Mod-Alt-6` | `wrapInHeadingCommand(level)`, `downgradeHeadingCommand` |
| **blockquote** | ✅ | ✅ `> ` | ✅ `Mod-Shift-b` | `wrapInBlockquoteCommand` |
| **bullet_list** | ✅ | ✅ `- ` `* ` `+ ` | ✅ `Mod-Alt-8` | `wrapInBulletListCommand` |
| **ordered_list** | ✅ | ✅ `1. ` | ✅ `Mod-Alt-7` | `wrapInOrderedListCommand` |
| **list_item** | ✅ | — | ✅ `Enter` (split), `Tab`/`Mod-]` (sink), `Shift-Tab`/`Mod-[` (lift), `Backspace`/`Delete` (lift first) | `splitListItemCommand`, `sinkListItemCommand`, `liftListItemCommand`, `liftFirstListItemCommand` |
| **code_block** | ✅ | ✅ ` ```lang ` | ✅ `Mod-Alt-c` | `createCodeBlockCommand(lang)`, `updateCodeBlockLanguageCommand` |
| **hr** (divider) | ✅ | ✅ `---`, `___ `, `*** ` | ❌ | `insertHrCommand` |
| **hardbreak** | ✅ | — | ✅ `Shift-Enter` | `insertHardbreakCommand` |
| **image** | ✅ | ❌ | ❌ | `insertImageCommand`, `updateImageCommand` |
| **html** | ✅ | — | — | (raw HTML 보존용) |
| **task list item** (`[ ] `) | ✅ gfm (list_item 확장) | ✅ `[ ] `, `[x] ` | ❌ | (없음 — 토글 명령 직접 추가 필요) |
| **table** | ✅ gfm | ✅ `\|2x2\|` | ✅ 셀 내부 `Tab`/`Shift-Tab`/`Enter`/`Mod-Enter`/`Mod-]`/`Mod-[` | (다양) |

### 11.3 핵심 시사점

**(A) Phase 1 최소 스펙은 사실상 코드 0줄로 90% 동작한다**
Style 드롭다운 / B / I / Link / Style 변환 모두 commonmark 명령이 이미 존재.
신규 작성이 필요한 것은:
- React 컴포넌트(`FormatToolbar`) — 명령을 호출하고 active 상태를 표시하는 껍데기
- Link mini popover (`toggleLinkCommand` payload 입력 UI)
- (옵션) Phase 1.5: Strike, Code, List 추가 — 명령 모두 존재

**(B) 마크다운 입력 룰은 완비** — 신규 추가 0
`# `, `**x**`, `> `, `- `, `1. `, `---`, ` ``` `, `[ ] ` 모두 동작. Esc/Cmd+Z 취소도 ProseMirror inputRules의 표준 동작이라 자동 보장.

**(C) 키맵 추가가 필요한 항목 (Phase 1)**
| 동작 | 현재 | 추가 필요? |
|---|---|---|
| Bold | `Mod-b` ⚠️ 충돌 | 충돌 해소 필요 (아래 §11.4) |
| Italic | `Mod-i` ✅ | 그대로 |
| InlineCode | `Mod-e` ✅ | 그대로 |
| Strike | `Mod-Alt-x` ✅ | 그대로 |
| Link | (없음) | `Mod-k` 검토 — ⚠️ CommandPalette와 충돌 |
| H1/H2/H3 | `Mod-Alt-1/2/3` ✅ | 그대로 |
| Bullet/Numbered | `Mod-Alt-8/7` ✅ | 그대로 (Notion/Linear와 다르지만 그대로 유지) |

### 11.4 ⚠️ writer-tauri 키맵 충돌 (필독)

스캔 대상: `apps/writer-tauri/src/**/*.tsx`의 `metaKey`/`ctrlKey` 핸들러

| 단축키 | writer-tauri 점유 | preset/계획과의 관계 |
|---|---|---|
| **`Mod-b`** | `components/ui/sidebar.tsx:99` (shadcn 기본 — 사이드바 토글) | 🚨 **commonmark `Mod-b` (Bold)와 정면 충돌** |
| **`Mod-k`** | `layout/CommandPalette.tsx:89` | ⚠️ Link 단축키 후보로 못 씀 |
| `Mod-r` | `main.tsx:11` (reload) | preset 무관, OK |
| `Mod-t` | `layout/Sidebar.tsx:136` (오늘 데일리로 점프) | preset 무관, OK |
| `Mod-1` | `AppShell.tsx:45` (사이드바 토글) | preset 무관, OK |
| `Mod-.` | `AppShell.tsx:48` (채팅 패널 토글) | preset 무관, OK |
| `Mod-\` | `AppShell.tsx:51` (양 패널 접기) | preset 무관, OK |
| `Mod-Shift-[/]` | `EditorTabs.tsx:40`, `ThreadTabs.tsx:67` | preset 무관, OK |
| `Mod-Enter` | `MarkPopover.tsx:38` (mark accept, popover 열렸을 때만), `chat/PromptInput.tsx:140` | preset의 table `Mod-Enter`는 셀 내부 한정이라 사실상 OK |

**🚨 `Mod-b` 충돌 분석**
- shadcn sidebar는 **window-level keydown 리스너** (capture/bubble 미설정 → bubble)
- ProseMirror commonmark keymap도 **window/contenteditable level**
- 일반적으로 ProseMirror가 contenteditable 안의 keydown을 먼저 잡고 `e.preventDefault()` 하지만, shadcn은 window 리스너라 `e.defaultPrevented` 체크 없이 발화될 수 있음
- **둘 다 발화 가능성 → 굵게는 적용되나 사이드바도 같이 토글**
- Phase 1에서 검증 + 둘 중 하나 변경 필요. 옵션:
  1. shadcn sidebar shortcut을 다른 키로 (`Mod-Shift-S` 등)
  2. shadcn sidebar shortcut 비활성화 (Cmd+1이 이미 같은 일을 함 → **중복**)
  3. ProseMirror에서 `Mod-b`를 우선 처리하도록 stopPropagation
- **추천**: 옵션 2. `Cmd+1`이 이미 사이드바 토글이라 shadcn 기본 `Cmd+B`는 군더더기. shadcn `useSidebar`의 keyboard prop을 끄면 됨

**⚠️ `Mod-k` 충돌 분석**
- CommandPalette가 점유 중. 라이팅 앱에서 Cmd+K = 명령 팔레트는 표준이라 양보가 어려움
- 노션은 Cmd+K = 링크. 노션 사용자 기대치 vs 현재 점유 사이 트레이드오프
- **추천**: Phase 1에선 링크 단축키 미정. 툴바 Link 버튼 + `[text](url)` 마크다운 직접 입력으로 커버. Phase 1.5에서 결정

### 11.5 Phase 1 작업 재산정

| 작업 | 상태 | 비고 |
|---|---|---|
| commonmark/gfm preset 인벤토리 | ✅ 완료 (이 §11) | — |
| 마크다운 입력 룰 보강 | **불필요** | 완비됨 |
| Bold/Italic/Code/Strike 키맵 | **불필요** | 완비됨 |
| H1~6, List, Blockquote 키맵 | **불필요** | 완비됨 |
| `Mod-b` 충돌 해소 | **필수** | shadcn sidebar 단축키 비활성화 (1줄 변경) |
| `FormatToolbar` 컴포넌트 | 신규 | active state 추적 + Style ▾ + B/I + Link |
| Link mini popover | 신규 | URL 입력 UI |
| EditorHeader 재구성 | 신규 | 탭 이식 + Breadcrumb 제거 + collab 라벨 이동 |
| proofMark 공존 검증 | 다음 단계 | 별도 작업 |

→ Phase 1 추정 시간이 ~4.5일에서 **~2~3일로 단축**.

---

## 12. proofMark 공존 검증 결과 (2026-05-09 조사)

검증 대상: 새로 활성화될 표준 마크(strong / emphasis / inlineCode /
strike_through / link)가 기존 proofMark(proofSuggestion / proofComment /
proofFlagged / proofApproved / proofAuthored / proofProvenance)와
schema·시각·직렬화에서 공존 가능한지.

### 12.1 proofMark schema 요약

| Mark | inclusive | excludes | spanning |
|---|---|---|---|
| proofSuggestion | false | (default) | true |
| proofComment | false | (default) | true |
| proofFlagged | false | (default) | true |
| proofApproved | false | (default) | true |
| proofAuthored | true | `'proofAuthored'` (자기 자신만) | true |
| proofProvenance | false | (default) | true |

ProseMirror `excludes` 기본값은 자기 자신만 → 표준 마크와 같은 range에
공존 가능.

### 12.2 검증 매트릭스

| 검증 항목 | 결과 | 근거 |
|---|---|---|
| Schema 충돌 | ✅ 안전 | 모든 proofMark의 excludes가 자기 자신만 → 표준 마크와 자유 공존 |
| inclusive 동작 | ✅ 자연스러움 | 표준 마크 inclusive=true (경계에서 확장), proofMark은 false (제안 범위 임의 확장 방지) — 둘 다 의도된 동작 |
| 마크다운 라운드트립 | ✅ 안전 | proofMark의 to/parseMarkdown은 dormant. 서버는 Yjs binary로만 동기화 |
| Yjs 동기화 | ✅ 안전 | 표준 마크는 commonmark/gfm preset이 이미 schema 등록 — 양 클라이언트 schema 일치 |
| `toggleInlineCodeCommand` proofMark 보존 | ⚠️ **위험** | 아래 §12.3 |

### 12.3 ⚠️ toggleInlineCodeCommand 위험

`@milkdown/preset-commonmark/.../inline-code.ts:71-83` 의 토글 구현이
"같은 range의 자기 자신을 제외한 모든 마크 강제 제거" 동작을 함:

```ts
const restMarksName = Object.keys(state.schema.marks).filter(
  (x) => x !== inlineCodeSchema.type.name
)
restMarksName.map((name) => state.schema.marks[name] as MarkType)
  .forEach((t) => { tr.removeMark(from, to, t) })
```

이 명령이 strong / emphasis / link 등 표준 마크뿐 아니라 **proofSuggestion
등 모든 proofMark도 같이 제거**한다. 시나리오:

1. AI가 텍스트에 proofSuggestion 마크를 걸어둠
2. 사용자가 같은 범위를 선택해서 inline code 토글
3. **proofSuggestion이 inline mark에서 조용히 사라짐**
4. Y.Map의 StoredMark는 남아 있어 "고아 상태" — UI에 표시 안 됨

inline code 자체는 마크다운 문법상 다른 inline 마크와 공존 못 하므로
("`**bold**`" = 코드 안의 별표 문자), 표준 마크 제거는 합리적이다.
문제는 proofMark처럼 포맷이 아닌 anchor 용도 마크까지 함께 사라진다는 점.

#### 해결 옵션
| 옵션 | 내용 | 평가 |
|---|---|---|
| **A** | Phase 1 툴바에서 inline code 버튼·단축키 제외 | 가장 단순. Phase 1.5로 미루기 |
| B | 자체 `toggleInlineCode` 명령 신규 — proofMark은 보존, 다른 inline 마크만 정리 | 정공법. Phase 1.5 도입 |
| C | preset 자체 패치 또는 schema의 excludes 조정 | 영향 범위 큼, 비추천 |

**Phase 1: A로 회피.** 이미 §5.2에서 Code/Strike를 Phase 1.5 후보로 분리해
둔 결정과 일치. Phase 1.5에서 코드 버튼을 추가할 때 B로 정공 해결.

### 12.4 결론

Phase 1 진입 가능. 단 다음 두 결정을 잠금:
- **Phase 1 툴바 최소 구성에 inline code 미포함** (§5.2의 최소 스펙 그대로)
- **Phase 1.5에서 inline code 추가 시 자체 토글 명령 작성 필수** (TODO)

---

## 13. 진행 상황 (2026-05-10)

### 13.1 완료 — Phase 1

| 항목 | 커밋 | 비고 |
|---|---|---|
| `Cmd+.` 통합 패널 토글 (Cmd+1, Cmd+\\ 제거) | `4998af15`, `5d4ec080` | shadcn 단축키 충돌 해소 |
| shadcn `Cmd+B` 단축키 제거 → PM Bold 양보 | `ce43c861` | — |
| EditorHeader 재배치 (탭 Row 1, Breadcrumb 제거) | `2948b23b`, `e16753ee` | — |
| FormatToolbar 컴포넌트 (Style ▾ + B + I) | `b1b1cf19`, `d01e8dee`, `91a6e517`, `948b0c6a` | active state 추적 포함 |
| Active mark/block 추적 (`formatStatePlugin`) | `8d387276` | zustand store 경유 |
| Link 버튼 + mini popover (Notion 스타일 word expand) | `99e6a3f9` | — |
| proofMark 공존 검증 | `c655f922` | §12 근거 |

### 13.2 완료 — Phase 1.5

| 항목 | 커밋 | 비고 |
|---|---|---|
| Strike 버튼 | `86ff8c88` | gfm preset의 `strike_through` mark |
| Inline Code 버튼 + proofMark-safe 토글 | `a187343a` | `inlineCodeSafe.ts` 신규 — §12.3 위험 회피 |

### 13.3 완료 — 링크 보강

| 항목 | 커밋 | 비고 |
|---|---|---|
| Cmd+click 외부 열기 | `60992bcf`, `af8c6cd9` | Tauri shell + capability + toast |
| `openLinkSafely` helper 추출 | `1d4e9ab2` | — |
| `linkHoverStore` + `getLinkRange` | `6f8aae4b` | — |
| `linkHoverPlugin` (감지) | `75e9d915` | — |
| `LinkHoverBar` (Open/Remove) | `5f93ce62` | — |
| 데드 존 수정 (GAP_PX=0 + padding-top) | `950e0cec` | §13.4의 3개 변경 적용 |
| Edit 액션 (LinkEditInput 공유) | `0b2d4f92` | FormatToolbar/HoverBar 양쪽 진입점 |

### 13.4 완료 — 신뢰성 인프라

| 항목 | 커밋 | 비고 |
|---|---|---|
| `setup-binaries.sh` (고정 버전 bun, idempotent) | `950e0cec` | postinstall + beforeDevCommand 훅 |
| `pack-sidecar.sh` 멱등화 | `950e0cec` | 입력 해시 비교로 스킵 |
| GitHub Actions CI (lint + typecheck + build 게이트) | `c5823016` | sibling proof-sdk checkout 포함 |
| ESLint flat config — `no-restricted-imports` (`@milkdown/*`) | `c5823016` | `@milkdown/utils` 직접 import 회귀 차단 |

### 13.5 완료 — Phase 2 슬래시 커맨드

| 항목 | 커밋 | 비고 |
|---|---|---|
| `slashStore` (zustand) | `f4a0eea0` | 평면 구조: open/query/coords/items |
| `slashItems` 정적 카탈로그 | `f4a0eea0` | 10개 항목 (Text/H1-3/Bullet/Numbered/Todo/Quote/Code/Divider) |
| `slashTriggerPlugin` (PM 트리거) | `f4a0eea0` | `/` 입력 감지 + 좌표 push |
| `SlashMenu` 컴포넌트 (cmdk) | `51b85cf0` | ↑↓/Enter/Esc 키보드 네비 |
| `wrapInTaskList` 단일 트랜잭션 | `c41398ab` | wrap + setNodeMarkup capture+compose |

### 13.6 완료 — Task list / list 동작

| 항목 | 커밋 | 비고 |
|---|---|---|
| `listItemBlockComponent` 등록 + `listItemConfig` (Tabler SVG) | `c41398ab` | Vue NodeView, shadcn 토큰 기반 |
| `listKeymap` — Enter (split with attrs / lift on empty) | `c41398ab` | task `checked` 보존 |
| `listKeymap` — Backspace (`liftListItem` 한 stroke) | `c41398ab` | PM 기본 두 stroke 회피 |
| 체크 mark 크기·간격 미세 튜닝 | `7bb490a9` | path width, line-height |

### 13.7 완료 — 셀렉션 페인트 사족 제거

이 브랜치 마지막 트랙. cross-block 셀렉션 페인트가 본문에 어색한 가로 줄을 만들던 두 원인을 제거.

| 항목 | 커밋 | 원인 / 수정 |
|---|---|---|
| list-item 사이 가로 줄 | `bafef19c` | `.list-item` 안쪽 li margin이 editable flex row 안에 있어 cross-block selection이 페인트. Crepe 패턴(`.milkdown-list-item-block`에 0 spacing) 채택 |
| `.label-wrapper user-select: none` | `bafef19c` | icon 열이 selection 사각형에 끼지 않게 |
| frozen-selection 데코 페인트 제거 | `df66ecf2` | blur 트리거가 너무 광범위해서 stale 녹색 박스가 본문에 영구로 남음. 시각 표시는 ChatPanel chip이 이미 담당 → 페인트는 사족. snapshot/`getFrozenRange` 로직과 self-heal은 유지 |

### 13.8 다음 작업 큐

doc이 명시한 큐는 Phase 1 / 1.5 / 2 모두 닫힘. 다음 우선순위는 명시되지 않음. 후보:

- **A. 슬래시 메뉴 카탈로그 보강** — §6.2가 언급한 Image 진입점 추가 (Wikilink는 `[[`로 별도 진입). 항목 그루핑 검토
- **B. proofMark 협업 검증 (§8 매트릭스 미완)** — 두 클라이언트 동시 편집으로 mark 전파·라운드트립 정식 통과 기록
- **C. Phase 3 신규 인라인 (§7)** — highlight, sub/super, 링크 hover preview
- **D. doc에 없는 새 우선순위** — 사용자 결정

확정 결정 (잠금):
- `Cmd+K` 재할당은 **취소** (사용자가 "원래대로 되돌려줘"로 reverted)
- 슬래시 메뉴에 Todo 포함 ✓ 적용됨
- 슬래시 메뉴에 AI 카테고리 미포함 (Phase 3에서 재검토)
