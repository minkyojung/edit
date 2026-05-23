# Context Engineering 파이프라인 계획

작성: 2026-05-19
참고 원문: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
선행 문서: [llm-wiki-redesign-plan.md](./llm-wiki-redesign-plan.md) (2026-05-13, Karpathy 정합화 1차)

이 문서의 목적: writer-tauri 의 wiki/ingest/chat 위에 **재사용 가능한 context engineering 파이프라인**을 얹는다. lint 는 그 파이프라인을 검증하는 첫 consumer 이며, 본질은 출력 형태가 아니라 메모리/파이프라인 인프라.

---

## 1. 핵심 인식 전환

**Before** (출력 중심)
- 목표 = lint daemon
- 메모리/인덱스 = 그 prerequisite

**After** (파이프라인 중심)
- 목표 = `assembleContext()` 파이프라인
- lint = 첫 consumer (검증)
- 미래 consumer (chat 개선, derive cells, dashboard 등) 는 system prompt + 출력 처리만 다르게

→ lint 가 폐기되어도 파이프라인 자산은 chat/ingest 위에 남는다.

---

## 2. 레이어 구조

```
┌─────────────────────────────────────────────────┐
│  Consumers (pluggable, 출력 형태별)              │
│  ├─ chat       (기존, B 블록에서 마이그레이션)   │
│  ├─ ingest     (기존, B 블록에서 마이그레이션)   │
│  ├─ lint       (신규, C 블록)                    │
│  ├─ derive     (미래, D 블록)                    │
│  └─ dashboard  (미래, D 블록)                    │
└─────────────────────────────────────────────────┘
         ↑ assembleContext(query)
┌─────────────────────────────────────────────────┐
│  Context Pipeline (재사용 자산)                  │
│  ├─ Tier 1: buildWikiIndex()                    │
│  ├─ Tier 2: selectHotPages(query)               │
│  └─ Tier 3: readPage(slug), searchWiki(query)   │
└─────────────────────────────────────────────────┘
         ↑ 사이드카 / 영속화 surface 읽음
┌─────────────────────────────────────────────────┐
│  Memory + 영속화 Layer                           │
│  ├─ .meta.json (aiSummary, aiImportance, ...)   │
│  ├─ _system/index.md   (LLM-written, 사용자 가시) │
│  ├─ _system/log.md     (append-only timeline)    │
│  └─ _system/conventions.md (schema doc)         │
└─────────────────────────────────────────────────┘
```

핵심: **중간 레이어(파이프라인) 가 진짜 자산**. 위/아래는 갈아끼울 수 있음.

---

## 3. 파이프라인 인터페이스

```ts
// agent/contextPipeline.ts
interface ContextBundle {
  index: string              // Tier 1 — wiki 카탈로그
  hotPages: WikiPageBody[]   // Tier 2 — 선별된 본문
  tools: AgentTool[]         // Tier 3 — readPage, searchWiki
  budgetUsed: number         // 디버깅
}

function assembleContext(query: {
  doc?: Slug          // 현재 작업 중인 doc (lint, ingest)
  text?: string       // 사용자 질문 (chat)
  budget?: number     // 토큰 예산 (default 30K)
}): Promise<ContextBundle>
```

모든 consumer 가 이 facade 로 들어옴. system prompt 만 다르게 작성.

---

## 4. Karpathy 정합성 검증

### 4.1 일치 항목 (그대로 진행)

| Karpathy 패턴 | 우리 구현 위치 |
|---|---|
| 3-tier discovery (index → 페이지 → synthesis) | Tier 1/2/3 |
| 임베딩/RAG 회피 (moderate scale) | 의도적 채택 |
| Plain markdown vault | Phase 4 (이미 완료) |
| Lint as 지속 maintenance role | Block C |
| Sidecar metadata (~frontmatter) | Phase A0 |
| LLM = writer / human = curator | ingest 가 이미 그렇게 작동 |
| 다양한 출력 형태 (consumer 분리) | Block D (architectural shift) |

### 4.2 추가가 필요한 항목

| Karpathy 패턴 | 우리 추가 phase |
|---|---|
| `index.md` 실제 파일 (git 추적, 사용자 가시) | A1 내부 수정 |
| `log.md` append-only 타임라인 | 신규 A6 |
| Schema 문서 (CLAUDE.md 패턴) | 신규 A7 |
| Provenance (출처 표시) | C1 system prompt 에 반영 |
| 인사이트 영속화 (chat → wiki) | 신규 D2 |
| 로컬 검색 도구 (qmd) | D3 (Tier 3 업그레이드) |

### 4.3 안 가져올 항목 (use case 차이)

- Raw Sources 폴더 (PDF/article ingestion) — 우리는 daily 가 source
- Marp 슬라이드, matplotlib 차트 — 스코프 밖
- Obsidian web clipper — 외부 ingestion 안 다룸
- Git 브랜칭 워크플로우 — vault 는 사용자 폴더, git 강요 안 함

---

## 5. Phase 구조

각 phase 끝마다 typecheck + tests + commit. 막힐 수 있는 큰 phase 는 sub-step 으로 쪼갬.

---

### **Block A — Memory + Pipeline (foundation)**

#### Phase A0 — 사이드카 스키마 확장

**무엇**: `.meta.json` 타입에 새 필드 추가. 런타임 변경 거의 없음.

```ts
interface DocSidecar {
  // 기존 필드 ...
  aiSummary?: string      // "VP of Operations, joined Q1 2024"
  aiImportance?: number   // 0-100, backlinks + recency 기반
}
```

**검증**: typecheck 통과. 기존 read/write 영향 0 (옵셔널).

**커밋**: `feat(sidecar): aiSummary / aiImportance 필드 정의`

---

#### Phase A1 — Tier 1: Wiki Index 빌더

**무엇**: 시스템 자동 생성 카탈로그. **메모리 캐시 + 디스크 영속화 둘 다.**

##### A1.1 — `firstNonEmptyLine` 헬퍼
- 파일: `lib/markdownUtils.ts`
- 순수 함수, body string → 첫 비어있지 않은 줄
- 단위 테스트

##### A1.2 — `countBacklinks` 헬퍼
- 파일: `state/wikiIndex.ts` 신규
- 정규식 `\[\[([^\]]+)\]\]` 로 wikilink 추출, target slug 카운트
- 단위 테스트

##### A1.3 — `buildWikiIndex()` 본체
```ts
export async function buildWikiIndex(): Promise<string> {
  const catalog = useDocsStore.getState().knownDocs
  const wikiPages = catalog.filter(d => d.type === 'wiki' && !d.archivedAt)

  const lines: string[] = []
  for (const doc of wikiPages) {
    const sidecar = await readSidecar(doc.slug)
    const summary = sidecar.aiSummary
      ?? firstNonEmptyLine(await readWikiMarkdown(doc.slug))
      ?? '(empty)'
    const linked = countBacklinks(doc.slug, catalog)
    lines.push(`- [${doc.slug}] ${doc.title} — ${truncate(summary, 80)} | linked: ${linked}`)
  }
  return lines.join('\n')
}
```
- `aiSummary` 없으면 본문 첫 줄 fallback
- 단위 테스트

##### A1.4 — 메모리 캐시 + invalidation
- `cachedIndex: string | null` 모듈 상태
- `getWikiIndex()` lazy getter, `invalidateWikiIndex()` exporter
- invalidate hook: docFileSync flush 끝 + vaultWatcher add/remove/reload 끝

##### A1.5 — 디스크 영속화 (`_system/index.md`)
- 매 invalidate 시 `wiki/_system/index.md` 에도 단방향 쓰기
- 사용자가 사이드바에서 열어볼 수 있음, git 추적 가능
- 사용자가 편집해도 다음 generation 에 덮어씀 (시스템 소유)

##### A1.6 — 기존 `readIndexContext` 갈아끼우기
- `agent/ingest.ts:641` 의 호출 → `getWikiIndex()` 로 교체
- 기존 ingest-edited "index" 페이지는 더 이상 LLM 컨텍스트로 안 들어감

**검증**:
- 단위 테스트 통과
- 앱 실행, wiki 페이지 만들고 `wiki/_system/index.md` 확인 → 새 줄 추가됐는지
- 사이드바에서 `_system/index.md` 열어보기 → 목록 표시되는지

**커밋**: `feat(wiki): Tier 1 index — memory cache + disk persistence`

---

#### Phase A2 — Tier 2: Hot Context Selector

**무엇**: 현재 작업과 관련된 wiki 페이지만 본문 통째로 로드.

##### A2.1 — `extractWikilinks` 헬퍼
- 본문 string → `[[Sarah]]`, `[[Acme Corp]]` 추출 → 슬러그/타이틀 배열
- `lib/markdownUtils.ts` 에 추가
- 단위 테스트

##### A2.2 — `selectHotPages` 함수
```ts
// agent/contextSelector.ts
export async function selectHotPages(
  source: { dailyBody?: string, queryText?: string },
  budget: number = 20_000,
): Promise<WikiPageBody[]>
```
- source 에서 wikilink/엔티티 추출 → 매칭되는 wiki 페이지 본문 로드
- 토큰 budget cap (합쳐서 budget 초과 시 importance 순으로 truncate)

**검증**: 데일리에 `[[Sarah]]` 박고 호출 → Sarah 페이지 본문 포함된 배열

**커밋**: `feat(context): Tier 2 hot page selector`

---

#### Phase A3 — Tier 3: Agent Tools

**무엇**: LLM 이 Tier 2 만으로 부족할 때 직접 호출.

##### A3.1 — `readPage(slug)` tool
- 파일: `agent/tools/readPage.ts`
- 입력: slug, 출력: 페이지 본문

##### A3.2 — `searchWiki(query)` tool (단순 버전)
- 파일: `agent/tools/searchWiki.ts`
- v1: 전체 wiki 본문 + 사이드카 grep, 일치 페이지 슬러그 반환
- v2 (Block D): qmd 또는 BM25 로 업그레이드

**검증**: 두 tool 단위 테스트 + agent runner 에서 호출 가능한지

**커밋**: `feat(agent): Tier 3 tools — readPage + searchWiki (grep)`

---

#### Phase A4 — `assembleContext()` Facade

**무엇**: 위 3 tier 를 묶는 통합 인터페이스. **모든 consumer 의 entry point.**

```ts
// agent/contextPipeline.ts
export async function assembleContext(query: {
  doc?: Slug
  text?: string
  budget?: number
}): Promise<ContextBundle> {
  const index = await getWikiIndex()
  const source = query.doc
    ? { dailyBody: await readDocBody(query.doc) }
    : { queryText: query.text }
  const hotPages = await selectHotPages(source, query.budget ?? 20_000)
  const tools = [readPageTool, searchWikiTool]
  return { index, hotPages, tools, budgetUsed: computeTokens(index, hotPages) }
}
```

**검증**: 단위 테스트 — daily slug 넣었을 때 index + 관련 페이지 반환

**커밋**: `feat(agent): assembleContext facade (consumer entry point)`

---

#### Phase A5 — Ingest 가 aiSummary 자동 생성

**무엇**: wiki 페이지가 ingest 로 업데이트되면 그 직후 LLM 으로 1줄 요약 생성, 사이드카 저장.

##### A5.1 — `generateAiSummary(body)` 함수
- 짧은 LLM 호출 (haiku, max 50 토큰)
- 프롬프트: "wiki 페이지 핵심을 1문장, 80자 이하"

##### A5.2 — ingest 후처리 hook
- `agent/ingest.ts` 끝에서 수정된 페이지마다 `generateAiSummary` 호출
- 사이드카 업데이트

**검증**: ingest 한 번 → wiki 사이드카 `aiSummary` 채워짐. 인덱스 호출 → fallback 안 쓰고 그 요약 사용.

**커밋**: `feat(ingest): auto-generate aiSummary in sidecar`

---

#### Phase A6 — `_system/log.md` Append-only Timeline

**무엇**: 모든 LLM 작업의 시간순 로그.

##### A6.1 — `appendToLog(entry)` 함수
- 파일: `state/wikiLog.ts` 신규
- `wiki/_system/log.md` 에 append-only
- 형식:
  ```
  ## [2026-05-19 14:23] ingest | daily/2026-05-19
  - Updated wiki/entity-sarah-kim
  - Created wiki/project-onboarding
  ```

##### A6.2 — ingest / lint / chat 각 path 에 호출 wire
- ingest 끝: 작업한 페이지 목록 append
- lint 끝: 박은 마크 수 append
- chat (provenance 인용된 경우): 인용 페이지 목록 append

**검증**: ingest/lint 돌리고 `_system/log.md` 확인 → 항목 추가됨

**커밋**: `feat(wiki): _system/log.md append-only timeline`

---

#### Phase A7 — `_system/conventions.md` Schema 문서

**무엇**: 사용자 편집 가능한 schema 문서. LLM 시스템 프롬프트에 포함.

##### A7.1 — 기본 conventions 파일 자동 생성
- `wiki/_system/conventions.md` 가 없으면 bootstrap 시 기본값으로 생성
- 기본 내용 = 기존 `DEFAULT_CONVENTIONS` (agent/ingest.ts) 의 markdown 버전

##### A7.2 — 시스템 프롬프트 wiring
- `assembleContext()` 가 conventions 본문도 반환 (또는 별도 getter)
- ingest / lint system prompt 에 conventions 포함

##### A7.3 — 기존 하드코딩 제거
- `DEFAULT_CONVENTIONS` 상수 → 파일에서 읽도록 전환

**검증**: conventions.md 편집 → 다음 ingest/lint 가 그 지시 따르는지

**커밋**: `feat(wiki): _system/conventions.md schema document`

---

### **Block B — 기존 Consumer 마이그레이션**

Block A 의 파이프라인을 기존 consumer 에 적용. 출시 가능 상태로 가는 검증 단계.

#### Phase B1 — chat → `assembleContext`

**무엇**: `agent/chat.ts:293` 의 `readWikiContext()` 호출을 새 파이프라인으로 교체.

- 기존: 전체 wiki 본문을 system prompt 에 박음
- 변경: `assembleContext({ text: userQuery })` → Tier 1+2 만 박음
- 효과: chat 토큰 비용 감소, wiki 페이지 많을 때 안 깨짐

**검증**: 기존 chat 시나리오 5개 + 새 시나리오 (wiki 50+ 페이지) 동작 확인

**커밋**: `refactor(chat): use assembleContext pipeline`

#### Phase B2 — ingest → `assembleContext`

**무엇**: `agent/ingest.ts:629` 도 동일하게.

**검증**: ingest 시나리오 동작 확인. wiki 업데이트 품질 동등 이상.

**커밋**: `refactor(ingest): use assembleContext pipeline`

---

### **Block C — Lint (첫 신규 consumer)**

#### Phase C1 — Lint Runner (manual trigger)

**무엇**: 실제 LLM 호출. 트리거는 아직 안 만듦.

##### C1.1 — `agent/lint.ts` 생성
- system prompt:
  ```
  당신은 사용자의 데일리 노트를 wiki 지식과 대조하는 리뷰어.

  Wiki 카탈로그 (전체 목록):
  {{index}}

  관련 wiki 페이지 본문:
  {{hotPages}}

  Schema / Conventions:
  {{conventions}}

  데일리의 각 문장에 대해:
  - wiki 와 모순되면 → comment 마크. rationale 에 출처 명시
    (예: "wiki/entity-sarah-kim 에서 VP of Operations 라고 적혀있음")
  - wiki 에 이미 있는 정보면 → "[[Sarah]] 참조" 링크 제안
  - 새 사람/프로젝트 언급되면 → "wiki 페이지 만들 만함" 제안

  마크 박을 때 propose_change 호출.
  ```
- **provenance 인용을 system prompt 에 명시** (Karpathy 정합)
- `propose_change` + `readPage` + `searchWiki` 를 relay 로

##### C1.2 — Dev console handle
```ts
if (import.meta.env.DEV) {
  ;(window as any).__lint = (slug: string) => runLint(slug)
}
```

##### C1.3 — Manual validation
- 데일리 쓰고 `window.__lint(activeSlug)` 호출
- 마크 품질 + 출처 인용 확인
- prompt 튜닝 반복

**검증**: 의도적 모순 데일리 → 마크 박힘 + rationale 에 wiki 페이지 인용

**커밋**: `feat(agent): lint runner with provenance (manual trigger)`

---

#### Phase C2 — Ambient 트리거

##### C2.1 — `lib/lintDaemon.ts`
- docFileSync dirty observer 에 hook
- 마지막 변경 후 5초 idle → `runLint(activeSlug)` 호출

##### C2.2 — Abort 처리
- AbortController 로 in-flight 취소

##### C2.3 — Throttle
- 같은 doc 60초 간격 최소

##### C2.4 — Daily 만 적용
- wiki/writing 은 skip

**검증**: 데일리 쓰다 멈추면 5초 후 마크 자동. 다시 타이핑 시 in-flight 중단.

**커밋**: `feat(lint): ambient daemon (idle trigger)`

---

#### Phase C3 — Dedup + UX

##### C3.1 — 기존 마크 LLM 전달 (dedup)
- runLint 시 markStore 에서 해당 데일리 마크 조회
- system prompt 에 "이 quote 들은 이미 마크 있음" 으로 포함

##### C3.2 — 상태 표시 UI
- 에디터 푸터에:
  - "AI 검토 중..." / "검토 완료 — N개 발견" / "변경 감지" / 빈 상태

##### C3.3 — 토글 설정
- settingsStore 에 `lintEnabled: boolean`
- 기본 true, 설정 페이지에 체크박스

**검증**: 같은 데일리 두 번 lint → 두 번째에 중복 마크 안 박힘. 토글 끄면 daemon 안 돔.

**커밋**: `feat(lint): dedup + status indicator + enable toggle`

---

#### Phase C4 — log 통합

**무엇**: lint 결과를 `_system/log.md` 에 기록.

- 매 lint 패스 후 append:
  ```
  ## [2026-05-19 14:30] lint | daily/2026-05-19
  - 3 marks (2 contradictions, 1 link suggestion)
  ```

**검증**: lint 후 log.md 새 줄

**커밋**: `feat(lint): append to _system/log.md`

---

### **Block D — 미래 확장 (별도 plan 으로 분리)**

여기는 지금 구현 안 함. 단, **파이프라인이 이걸 지원할 수 있게 설계 미리**.

#### Phase D1 — AI-derive Cells

`{{ai-derive: query='...'}}` 같은 인라인 셀. `assembleContext` 호출해서 derived 콘텐츠 렌더.

#### Phase D2 — 인사이트 영속화 (chat → wiki)

**Karpathy 의 "explorations compound" 패턴.**

- 채팅 답변이 인용 포함하면, 답변 끝에 "wiki 페이지로 저장" 버튼
- 또는 LLM 이 자동 감지: "이거 새 wiki 페이지 만들 만함" 제안
- 저장 시 `wiki/explorations/` 또는 적절한 페이지 타입으로 commit

#### Phase D3 — qmd 로컬 검색 (Tier 3 업그레이드)

**Karpathy 가 언급한 qmd = 파일 포맷이 아니라 BM25 + 벡터 + MCP 검색 도구.**

- 현재 A3 의 `searchWiki` 는 grep 기반 단순 버전
- D3: qmd (또는 동등한 BM25/벡터 도구) 로 교체
- agent tool 호출 인터페이스는 동일, 내부 구현만 업그레이드

#### Phase D4 — Dashboard 위젯

`assembleContext({ budget: 5K })` 로 가벼운 위젯 컨텍스트. React 컴포넌트로 렌더.

#### Phase D5 — Raw Sources Ingestion

Slack 스레드, 미팅 노트, 외부 article 을 vault 에 떨구면 ingest 가 처리. v1 스코프 밖.

---

## 6. 마일스톤별 출시 가능 상태

| 시점 | 무엇이 되나 | 출시 가능? |
|---|---|---|
| Block A 끝 | 파이프라인 자산 확보, ingest 만 마이그레이션 됨 | ❌ (사용자 가시 변화 적음) |
| Block B 끝 | chat/ingest 가 새 파이프라인. 효율 향상 + wiki 페이지 많아도 안 깨짐 | ✅ 1단계 |
| Block C1 끝 | dev console 에서 수동 lint 가능 | ❌ (manual only) |
| Block C 끝 | ambient lint daemon 작동 + UI | ✅ 2단계 (lint 출시) |
| Block D | 향후 결정 | — |

---

## 7. 위험 / 완화

| 위험 | 완화 |
|---|---|
| `_system/index.md` 디스크 쓰기 빈도 과다 | 메모리 캐시 우선, invalidate 후 debounce 200ms 후에만 디스크 쓰기 |
| ambient lint 의 토큰 비용 폭주 | 60초 throttle + 변경 없으면 skip + haiku 고정 |
| 마크 노이즈 | C3 dedup + Block A 의 prompt 튜닝으로 흡수 |
| conventions.md 사용자 편집 실수 | bootstrap 시 미존재면 기본값으로 생성. 잘못된 내용도 LLM 이 robust 하게 처리 |
| 외부 도구 (Obsidian) 에서 `_system/` 폴더 노출 | `_` prefix 가 정렬상 맨 위/아래로 분리됨. 시스템 폴더임을 인식 가능 |

---

## 8. 검증 (각 phase)

1. `pnpm typecheck` — 컴파일 오류 0
2. `pnpm test` — 테스트 통과
3. 큰 phase (A1, A4, C2): 앱 실행 검증
   - wiki 페이지 만들기 → 인덱스 업데이트
   - 데일리 쓰기 → idle 후 lint 호출
   - chat 질문 → 효율적 wiki 컨텍스트 사용

---

## 9. 첫 행동

**Phase A0 부터.** 사이드카 스키마 확장 — 5-10분 작업, 거의 무위험.

진행 전 확인할 것:
1. `apps/writer-tauri/src/state/docsStore/types.ts` 또는 사이드카 정의 위치 정확히 잡기
2. 기존 사이드카 read/write 함수 위치 확인 (옵셔널 필드 추가가 무해한지)

---

## 부록 A — 기존 LLM Wiki 재설계 plan 과의 관계

`docs/llm-wiki-redesign-plan.md` (2026-05-13) 은 1차 Karpathy 정합화 — 인덱스 도입, cross-link 압력, ingest 분리 등 **wiki 컨텐츠 구조**에 집중.

이 문서 (2026-05-19) 는 그 위에 얹는 **런타임 context engineering 인프라** — pipeline facade, tier 구조, consumer 추상화.

선행 작업 (1차 plan) 이 만든 "잘 짜인 wiki 구조" 가 이 plan 의 **input** 이고, 이 plan 은 그걸 LLM 이 어떻게 효율적으로 소비하는지를 다룬다.

## 부록 B — 용어 정리

- **Tier 1 (Index)**: 모든 wiki 페이지의 한 줄 요약 카탈로그. 항상 system prompt 에 포함. ~2-5K 토큰.
- **Tier 2 (Hot)**: 현재 작업과 관련된 페이지 본문 통째로. ~10-20K 토큰.
- **Tier 3 (Cold)**: LLM 이 필요시 tool 호출로 접근. 무제한.
- **assembleContext**: 위 3 tier 를 묶는 facade. 모든 consumer 의 entry point.
- **Consumer**: 파이프라인 위에서 도는 LLM 작업 (chat, ingest, lint, derive, ...).
- **Provenance**: LLM 응답이 wiki 페이지 출처를 명시적으로 인용하는 패턴.
- **Compounding artifact**: 매번 다시 합성하지 않고 한 번 추출/통합해서 영속화하는 지식 (Karpathy).
