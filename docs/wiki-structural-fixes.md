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

| 순 | 수정 | 상태 | 해결되는 root | 해결되는 증상 | 분량 |
|---|---|---|---|---|---|
| 1 | **A — title 분리** | ✅ 완료 (0c8adbbe) | Root A | 1, 3 | 30 분 |
| 2 | **B — 페이지 dedup** | ⏳ 미진행 | Root B | 1 (중복), 6 일부 | 30 분 |
| 3 | **D — 내용 dedup** | ✅ 완료 (b91bc9b4) — sink-side 큐 필터가 아닌 source-side 블록 해시 + 단위-닫힘 트리거로 구조적 해결 | Root D | 2 | (실제 ~3 시간) |
| 4 | **C — apply 통일** | ⏳ 미진행 | Root C | 4 | 1 시간 |
| 5 | **E — body seed 정리** | ⏳ 미진행 | (Root C 파생) | 5 | 20 분 |

A + D 완료로 가장 큰 증상 (중복 누적, raw 텍스트 제목) 해소.

남은 B / C / E 는 작은 corner case (같은 이름 새 페이지 매번 생성, log 페이지 markdown 안 꾸며짐, 새 페이지 첫 줄 빈 칸).

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

### D — 내용 dedup ✅ 완료 (b91bc9b4)

**원래 계획**: `enqueue` 에서 sink-side 큐 필터링.

**실제 해결**: 더 근본적인 source-side 구조로 대체.

1. **블록 해시** (`lib/blockHash.ts`): 데일리 본문을 문단 단위로 split → SHA-256 → `ingestStore.ingestedBlockHashes` 에 persist. `runIngest` 가 안 본 블록만 LLM 에 전달.
2. **트리거 재설계**: 5분 idle 폐기. 대신 (a) active doc 변경 (zustand subscribe), (b) 자정 / 날짜 바뀜 (30분 polling) — "단위 닫힘" 시점에만 발화.

**이유**: 원래 계획은 LLM 이 중복 제안 만든 후 큐에서 거르는 사후 처리. 그런데 같은 데일리 전체를 매 5분마다 LLM 에 다시 보내는 게 원인이라 source-side 가 정공법. 같은 블록이 LLM 에 두 번 도달하는 것 자체가 코드 차원에서 불가능.

**효과**: 글자 중복 100% 차단 (해시 비교). 의미 중복은 lint pass 가 사후 정리 (별도 phase). 토큰 비용도 동시 감소.

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
