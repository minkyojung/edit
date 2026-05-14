# ADR: proof-sdk 정합 회귀 + Y.UndoManager 통합

작성: 2026-05-10
상태: **Accepted**
이전 ADR: `2026-05-10-ingest-review-restructure.md` (Path A 결정 — 본 ADR 가 그 결정을 뒤집음)
관련 메모: `2026-05-10-chat-insert-server-roundtrip.md`

---

## Context

`2026-05-10-ingest-review-restructure.md` 에서 Path A 를 선택했음:
- 콘텐츠를 PM 트리에 직접 박고 그 범위에 mark
- single source of truth (PM)
- accept = 마크만 떼기, reject = 범위 삭제

이 결정이 두 버그 (blockquote 위치, Cmd+Z) 의 "공통 뿌리" 를 단일 권위로 풀자는 의도.

Phase 1, A, B + Step 1, 2, 3, Phase 4 순으로 구현. 그러던 중 chat-INSERT 시점에 결정적 회귀 발견:

> 사용자가 Keep 누르면 마크된 콘텐츠가 ~50ms 안에 삭제됨

진단 (`2026-05-10-chat-insert-server-roundtrip.md`):
- 우리 PM-transaction 자체는 정상 (콘텐츠 0 변화)
- 그 직후 외부 transaction (proof-server reconciliation) 이 chat-INSERT 콘텐츠 통째 revert
- proof-server 는 자기 markdown projection 과 안 맞으면 "drift" 로 판단해 되돌리는 guardrail 있음

proof-sdk 의 [공식 문서](https://github.com/EveryInc/proof-sdk) 확인 결과:
> "Use `edit/v2` for deterministic block-level edits.
> Use `edit` for simple string-based operations.
> **Use `ops` for reviewable suggestions, comments, and rewrites.**
> Pick one — don't mix them."

`ops/suggestion.add` 의 모델: **anchor 는 기존 doc 안 텍스트, content 는 메타데이터로**. doc 자체엔 변화 없음. server 는 metadata-shape 변경만 봄. drift 발생 0.

= **Path A 의 PM-tree 모델은 proof-sdk 의 ops 와 edit/v2 를 짬뽕한 것.** server 가 "섞지 마라" 고 명시한 그것.

---

## Decision

**Path A 회귀 + proof-sdk 의 ops/suggestion.add 패턴으로 정합.**

추가로, dual-source-of-truth (PM ↔ Y.Map sync) 의 근본 해결을 위해 **Y.UndoManager 통합** 도입.

### 회귀된 모델

```
시각:
  anchor     → 기존 페이지 텍스트의 마지막 단어에 dashed underline (proofSuggestion 마크)
  preview    → Decoration.widget 으로 anchor 의 top-level sibling 자리에
                multi-block ghost widget (markdown → DOMSerializer → DOM)
  서버 시점  → mark 추가만 보임. doc 변화 0. drift 없음.

데이터:
  PM 마크    → id / kind / by 만 (thin anchor)
  Y.Map      → content (제안된 markdown), quote, source 메타, status

흐름:
  Accept  → parser(Y.Map.content) → PM Fragment → tr.insert + tr.removeMark
            (이때 PM doc 가 진짜로 바뀜 — server 는 normal user edit 으로 받아들임)
  Reject  → tr.removeMark only (콘텐츠는 PM 에 한 번도 없었음)
```

### Cmd+Z 정합

문제: `marksMap.set/delete` 가 PM transaction 과 별개의 Yjs 변경 → milkdown 의 PM history plugin 은 PM 만 추적 → Cmd+Z 가 PM 만 되돌림 → Y.Map 어긋남 → 재-accept 시 markCantRead 에러.

해결:
1. `.use(history)` 제거 — milkdown 의 collab 플러그인이 이미 `yUndoPlugin` 을 내장. 둘이 충돌하던 Mod-Z 키바인딩 통일.
2. `Y.UndoManager([xmlFragment, marksMap])` — PM XmlFragment + 메타 Y.Map 둘 다 트래킹.
3. `collabService.setOptions({ yUndoOpts: { undoManager } })` — 우리 UndoManager 를 yUndoPlugin 에 주입.
4. `acceptMark` / `rejectMark` 의 dispatch + Y.Map 변경을 `ydoc.transact(fn, 'mark-action')` 으로 wrap. UndoManager 의 `trackedOrigins` 에 'mark-action' 등록.

= 두 Yjs 영역의 변경이 한 undo step. Cmd+Z 가 PM 마크 + Y.Map 메타 atomic 복원.

---

## Why this reverses Path A

Path A 의 진단에서 "두 버그 (blockquote 위치 / Cmd+Z) 의 공통 뿌리는 3 진실 소스" 라고 본 게 절반만 맞았음:

| 옛 진단 | 사실 |
|---|---|
| "PM 트리 + Y.Map + ghost widget — 3 진실 소스 정합 어긋남이 뿌리" | **Y.Map 변경이 PM undo 와 따로 노는 게 진짜 뿌리** (Yjs UndoManager 미통합) |
| "패턴을 갈아엎어 PM 단일 권위로 만들면 해결" | proof-server 가 "섞지 마라" 한 패턴으로 가는 거였음 → drift |
| blockquote 위치 버그 | `topLevelSiblingAfter` 헬퍼 봉합 만으로 해결 가능 (Path A 안 가도 됨) |
| Cmd+Z 버그 | UndoManager 통합으로 정공법 해결 (Path A 안 가도 됨) |

→ **Path A 는 진단 오류로 인한 큰 우회였음.** 정공법은 plugins/wiring fix (UndoManager) 였음.

---

## Consequences

### Positive
- proof-server 와 호환 회복 (drift 0)
- Cursor 식 inline preview 유지 (ghost widget — decoration only, 서버 안 봄)
- Cmd+Z 가 모든 mark 액션에 대해 atomic 복원
- chat·ingest INSERT 가 같은 path 로 통일됨 (applyProposal 안에서)
- 이번 작업 누적 dual-source 패치들이 사실상 redundant 가 됨 (UndoManager 가 본질 해결)

### Negative
- 며칠 작업 (Path A 의 Phase 1~Step 3) 일부가 결과적으로 우회 → revert
- 이번 ADR 가 옛 ADR 를 뒤집음 → ADR 일관성에 흠
- ghost widget 의 한계 (텍스트 선택 / pre-accept 편집 불가) 받아들임

### Trade-offs
- proof-sdk 의 ProofEditor 컴포넌트 자체는 import 안 함 (디자인 자유도 위해 — 옛 path-b-rewrite ADR 결정 그대로). 우리는 schema + Y.Map + UndoManager 패턴만 따름.
- proofMarkSchemas.ts 의 Step 1+2 추가 attrs (sourceSlug 등) 는 그대로 둠 — backward compat. 새 마크는 메타를 Y.Map 에만 쓰고 attrs 안 채움.

---

## 교훈 — 다음 사람을 위해

### 1. proof-sdk 의 3 가지 편집 모델 절대 섞지 말 것

```
edit/v2     — block-level deterministic edits (recommended)
edit        — simple string ops
ops         — reviewable: suggestions, comments, rewrites
```

review-able 흐름 (사용자 accept/reject 가 있는 것) 은 **무조건 ops/suggestion.add 모델**. doc 직접 수정 (edit/v2) 과 섞으면 server guardrail 발동.

### 2. dual-source-of-truth 패턴은 Y.UndoManager 로 푸는 게 정답

Y.Map 같은 메타 store 와 PM doc 가 같이 변경될 때 Cmd+Z 가 한쪽만 되돌리는 문제는 흔함. 해결책은:

```
1. Y.UndoManager([type1, type2, ...]) 로 여러 Yjs 타입 트래킹
2. 변경을 ydoc.transact(fn, originTag) 로 wrap
3. trackedOrigins 에 originTag 등록
```

이걸 "패턴 자체를 갈아엎어 single source of truth 만들자" 로 풀려고 하면 다른 함정 (server 호환, scope 폭증) 으로 옮길 뿐.

### 3. Milkdown 의 `.use(history)` + `.use(collab)` 은 conflict

milkdown 의 collab 플러그인이 이미 yUndoPlugin 을 내장. `.use(history)` 추가하면 중복 PM history + 키바인딩 conflict. **collab 쓰면 history 빼야 함.**

### 4. Decoration.widget vs PM 노드 — server-visibility 차이

```
PM 노드            → server 가 봄 → guardrail 검증 통과해야 함
Decoration.widget  → 클라 전용 → server 안 봄 → 자유롭게 사용 가능
```

review preview UI 는 widget 으로 만들어야 server 충돌 없음. PM 트리에 넣으면 drift.

### 5. ADR 가 틀릴 수 있다는 가정 유지

옛 `2026-05-10-ingest-review-restructure.md` 가 Path A 를 "정공법" 이라고 명시. 같은 날 (몇 시간 후) 본 ADR 가 그걸 뒤집음. ADR 는 영구 진실이 아님 — 진단의 snapshot. 실 테스트 / 외부 시스템 (server) 과의 만남에서 깨질 수 있음. 새 정보 들어오면 다시 결정 가능해야 함.

---

## Files (현 상태)

핵심 코드:
- `apps/writer-tauri/src/agent/applyIngest.ts` — anchor 모델 (commit `dbf401fb`)
- `apps/writer-tauri/src/agent/applyProposal.ts` — INSERT short-circuit 제거 (commit `eea3e04b`)
- `apps/writer-tauri/src/editor/markActions.ts` — accept/reject anchor 모델 + ydoc.transact wrap (commits Phase 4 + `ffab86f4`)
- `apps/writer-tauri/src/editor/markDecoPlugin.ts` — ghost widget INSERT 부활 (commit `eea3e04b`)
- `apps/writer-tauri/src/editor/MilkdownEditor.tsx` — history 제거 + UndoManager 주입 (commit `ffab86f4`)
- `apps/writer-tauri/src/index.css` — .mark-deco--insert subtle, .mark-ghost--insert block-level (commit `eea3e04b`)

---

## 한 줄

**proof-sdk 의 ops/suggestion.add 패턴 + Y.UndoManager 통합 = drift 없는 review UX + 정합한 Cmd+Z.** Path A 의 PM-tree 모델은 server 가 명시적으로 거부하는 패턴이었고, Cmd+Z 문제는 패턴 자체가 아니라 wiring (UndoManager 미통합) 문제였음.
