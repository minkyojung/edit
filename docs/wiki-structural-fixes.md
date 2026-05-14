# 위키 구조적 수정 — 6 개 문제 → 4 개 뿌리 → 5 개 수정

작성: 2026-05-14

이 문서: 사용자가 발견한 위키 6 개 증상을 모두 패치하지 않고, **4 개 구조적 뿌리를 고쳐서 한 번에 해결**하기 위한 분석 + 수정 계획.

---

## 발견된 6 개 증상

| # | 증상 |
|---|---|
| 1 | AI 가 정한 제목이 본문 첫 줄로 자꾸 바뀜 |
| 2 | 같은 정보가 위키에 여러 번 저장됨 |
| 3 | 사이드바에 `[wiki:custom-XXX] <...` 같은 raw 텍스트가 제목으로 노출 |
| 4 | Log 페이지의 `##` markdown 이 안 꾸며짐 (literal text) |
| 5 | 새 위키 페이지 첫 줄이 빈 칸 |
| 6 | 위키가 카테고리 없이 평면 |

---

## 4 개 구조적 뿌리

| Root | 무엇 | 어디 | 영향받는 증상 |
|---|---|---|---|
| **A** | 제목이 항상 본문 첫 줄에서 추출 (`installTitleMirror` 가 daily 만 보호, 나머지는 body 가 이김) | `state/docsStore.ts:1304~1335` | 1, 3 |
| **B** | 같은 이름 페이지 매번 새로 생성 — slug 와 title 분리 안 됨 | `state/wikiService.ts:createCustomWikiPage`, `useIdleTrigger.materializeNewPageProposals` | 1 (중복), 6 일부 |
| **C** | "markdown → 페이지" 변환이 4 가지 다른 방식 (banner / log / index / seed) | `applyIngest.ts` / `wikiService.ts` / `WikiPageBanner.tsx` | 4, 5 |
| **D** | 콘텐츠 dedup 부재 — 같은 fact 가 여러 ingest pass 에서 재제안 | `state/ingestStore.ts:enqueue` | 2 |

(Root 5 카테고리 onboarding 은 UI 작업이라 별도)

---

## 향후 계획 (1~5번) 으로 해결되나? — 안 됨

| 향후 작업 | 해결되는 root |
|---|---|
| Query 환류 / Unified 프롬프트 / system:about | — |
| Phase 2 (index 기반 프롬프트) | D 보조만 |
| Lint | B, D **사후 정리만** (사용자 수동) |

4 개 root 모두 별도 수정 필요.

---

## 수정 5 개 (권장 순서)

| 순 | 수정 | 비유 | 해결되는 root | 해결되는 증상 | 분량 |
|---|---|---|---|---|---|
| 1 | **A — title 분리** | 책 표지 제목은 표지에 적힌 그대로. 본문 첫 줄 따로. | Root A | 1, 3 | 30 분 |
| 2 | **B — 페이지 dedup** | 같은 이름 폴더 있으면 새로 안 만들고 그쪽에 추가 | Root B | 1 (중복), 6 일부 | 30 분 |
| 3 | **D — 내용 dedup** | 중복 메일 자동 거름 | Root D | 2 | 30 분 |
| 4 | **C — apply 통일** | 모든 부서가 같은 인쇄소 사용 | Root C | 4 | 1 시간 |
| 5 | **E — body seed 정리** | 새 노트가 깨끗한 첫 줄에서 시작 | (Root C 파생) | 5 | 20 분 |

**총 약 3 시간** 에 6 개 문제 + 4 개 root 동시 해결.

(Root 5 / 증상 6 의 onboarding UI 는 별도 1+ 시간, 우선순위 낮음.)

---

## 수정별 상세

### A — title 분리

**문제**: 위키 / 시스템 페이지가 catalog 에 title 을 가지고 있어도, 사용자가 페이지 열면 자동으로 body 첫 줄 텍스트가 그 title 을 덮어씀.

**현재 코드** (`state/docsStore.ts:1304`):
```ts
function installTitleMirror(...) {
  if (known?.type === 'daily') return  // ← daily 만 보호
  // ... 모든 다른 type 에 대해 body→title 자동 sync
}
```

**수정**: daily 외에 system:* 와 wiki:* 도 mirror 건너뜀. catalog 의 title 이 정식 source of truth.

**왜 안전한가**: writing (사용자 일반 노트) 는 그대로 동작. wiki / system 만 보호.

---

### B — 페이지 dedup

**문제**: AI 가 `suggestNewPage: "Work"` 제안하면 매번 새 slug. "Work" 가 이미 있어도 새로 만듦.

**현재 코드** (`hooks/useIdleTrigger.ts:76`):
```ts
const newSlug = await createCustomWikiPage(name, body, ...)
// name 으로 기존 페이지 검색 안 함
```

**수정**: `materializeNewPageProposals` 가 `name` 으로 기존 wiki:custom-* 검색 → 있으면 그 slug 사용 (proposal 을 target 으로 전환).

**효과**: AI 가 "Work" 다시 만들려고 해도 기존 Work 페이지에 append.

---

### D — 내용 dedup

**문제**: `enqueue` 가 같은 content 의 proposal 도 중복 추가.

**현재 코드** (`state/ingestStore.ts:enqueue`):
```ts
const newProposals = proposals.map((p) => ({ ...p, id: crypto.randomUUID(), ... }))
// 기존 큐와 비교 없음
```

**수정**: 새 proposal 의 (target + content trimmed) 또는 (sourceQuote) 가 기존 큐에 있으면 skip.

**효과**: 같은 fact 가 두 번 큐에 안 들어감.

---

### C — apply 통일

**문제**: log 만 markdown 파싱 없이 plain text 로 박힘. `## [date]` 가 literal 표시.

**현재 코드** (`agent/applyIngest.ts:18~25`):
```ts
function appendParagraphViaTransaction(view, line) {
  const textNode = schema.text(line)  // ← parser 없음
  const para = paragraph.create(null, textNode)
  view.dispatch(tr.insert(end, para))
}
```

**수정**: 단일 헬퍼 `appendMarkdownAt(view, markdown)` 만들기. parser 거쳐서 PM Fragment 변환 후 insert. 모든 apply 경로 (log / index / banner accept) 가 호출.

**효과**: log 도 markdown 렌더링됨. 일관된 변환 path.

---

### E — body seed 정리

**문제**: 새 페이지 본문 시작에 빈 paragraph 박힘.

**현재 코드** (`state/wikiService.ts:createCustomWikiPage`):
```ts
const initialBody = body && body.trim().length > 0 ? body : ''
proofClient.createDoc(trimmed, initialBody, { slug })
```

server projection 또는 Milkdown schema fill 이 빈 paragraph 추가. 또는 markdown 의 leading newline 이 첫 빈 paragraph 로 변환.

**수정**: `body` 시작의 빈 줄 / leading whitespace trim. 또는 PM seed 단계에서 빈 첫 paragraph 명시적 제거.

---

## 진행 순서

1. **A** → A 끝나면 commit + push
2. **B** → commit + push
3. **D** → commit + push
4. **C** → commit + push
5. **E** → commit + push

각 단계마다 비개발자도 이해 가능하게 설명 + 검증.

---

## 한 줄

**6 개 표면 문제 → 4 개 진짜 뿌리 → 5 개 수정 (총 ~3 시간) 이 정공법.**
