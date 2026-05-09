# Markdown Styling — 구현 계획

작성: 2026-05-09
상태: Phase 1 착수 전 합의안

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

