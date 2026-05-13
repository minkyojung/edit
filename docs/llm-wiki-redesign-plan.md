# LLM Wiki 재설계 계획

작성: 2026-05-13
참고 원문: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

이 문서의 목적: Karpathy의 LLM Wiki 패턴을 기준으로, 현재 writer-tauri의 위키/ingest/proof-sdk 구조가 어디까지 정합하고 어디가 어긋났는지 정리하고, 항목별로 어떻게 수정할지 한 군데에 기록한다.

---

## 1. Karpathy LLM Wiki — 기준이 되는 구조

**핵심 문제 의식**
- 보통의 RAG: 매번 원본을 재탐색·재합성. 같은 사실을 매번 다시 합성하니 누적되지 않음.
- 사람이 직접 위키를 유지하면: 읽기·사고는 가치 있지만 정리·교차참조·갱신 같은 "bookkeeping"이 부담돼 결국 방치됨.

**해법 한 줄**: LLM이 영구적·점증적·상호 링크된 markdown 위키를 유지보수. 읽기/판단은 사람이, 사무는 LLM이.

**3계층 구조**
- 원본(raw sources) — 불변. LLM은 읽기만.
- 위키(wiki) — LLM이 쓰고 갱신. 요약/엔티티/개념 페이지로 구성.
- 규약(schema) — CLAUDE.md 같은 운영 문서. LLM을 디시플린된 사서로 변환.

**3가지 동작**
- **Ingest**: 새 원본 도착 → 분석 → 관련 위키 페이지 갱신 + 로그 기록.
- **Query**: 질문 → 위키 검색 → 인용 포함 답 합성 → 유의미한 발견은 새 위키 페이지로 환류.
- **Lint**: 주기적 헬스체크 — 모순/오래된 주장/외톨이 페이지/지식 공백.

**보조 파일 2개**
- `index.md` — 모든 페이지의 카탈로그 + 한 줄 요약. 네비게이션의 핵심.
- `log.md` — append-only 타임라인. 일관된 prefix로 파싱 가능.

**핵심 통찰**: "지식베이스 유지의 고된 부분은 읽기·사고가 아닌 bookkeeping이다. 사람은 권태로 위키를 버리지만 LLM은 그렇지 않다."

---

## 2. 현재 우리 구조 — 매핑

| Karpathy | 우리 (writer-tauri) | 상태 |
|---|---|---|
| Raw sources | `daily/*` 노트 + 일반 노트 | ⚠ raw와 writing surface가 같은 표면 |
| Wiki | `wiki:custom-*`, `wiki:log` | ✅ |
| Schema (CLAUDE.md) | `wiki:conventions` (사용자 편집 가능) | ✅ 정확히 매핑됨 |
| Ingest | `runIngest()` + `applyIngest.ts` + ingestStore 큐 + lazy materialize | ✅ 구현됨 |
| Query | (없음 — 일반 chat만) | ❌ 누락 |
| Lint | (없음) | ❌ 누락 |
| `index.md` | 사이드바 리스트만 (LLM이 안 봄) | ⚠ 요약 없음 |
| `log.md` | `wiki:log` (tail 30 lines) | ✅ |

**우리만의 추가 조건**
- proof-sdk라는 별도 시스템이 있고, 그 위에 "글에 인라인 댓글/제안" 마크 시스템이 따로 존재.
- daily 노트가 동시에 "사용자가 글 쓰는 화면"이자 "ingest의 원본"이라 경계가 모호.
- GUI 에디터(Milkdown + ProseMirror + Yjs)라서 검토 UI를 어떻게 보여줄지 별도 설계 필요.

---

## 3. 수정 계획 — 항목별

### 3.1 목차 페이지(index) 도입 — 우선순위 2

**Karpathy 원형**
- 모든 페이지의 한 줄 요약을 `index.md`에 모음.
- 새 원본을 정리할 때 LLM은 평소엔 `index.md`만 보고, 자세한 내용이 필요할 때만 해당 페이지를 열어봄.

**현재 우리 코드**
- `readWikiContext()` (`apps/writer-tauri/src/state/wikiService.ts:213`)가 매 ingest마다 모든 위키 페이지 본문을 통째로 프롬프트에 박음.
- 사이드바(`WikiSection.tsx`)는 사람용 리스트일 뿐 LLM은 안 봄.

**무엇을 만든다**
- `wiki:index` 페이지 신설. ingest가 위키를 갱신할 때 해당 페이지의 요약 줄도 같이 갱신.
- `readWikiContext()`는 본문 대신 index만 프롬프트에 넣음.
- LLM이 특정 페이지 본문을 보고 싶을 때 명시적으로 요청하는 경로(tool use 또는 후속 호출)를 마련.

**우리 맥락 고려**
- 사용자가 직접 위키 페이지 본문을 수정할 수 있음 → index 요약과 본문이 어긋날 수 있음. 사용자 편집 후 다음 ingest에서 해당 페이지 요약을 LLM이 재생성하도록 트리거 필요.
- 위키 페이지가 0~5개인 초기엔 굳이 index를 쓸 이유가 없음 → 임계점(예: 페이지 ≥ 8) 넘으면 활성화하는 단계적 도입도 가능.

---

### 3.2 Query 동작 추가 — 우선순위 4

**Karpathy 원형**
- 질문 → 위키 검색 → 인용 포함 답 합성 → 유의미한 발견은 새 위키 페이지로 환류.
- 위키가 "쓰기 + 읽기" 양방향 흐름을 가져야 누적의 가치가 닫힘.

**현재 우리 코드**
- 일반 chat은 있음. 그러나 "내 위키 기반으로 답해줘 + 출처 표시 + 새 사실은 위키로 환류" 흐름은 없음.

**무엇을 만든다**
- 채팅에 "wiki 기반 답" 모드 추가. 동작:
  1. `wiki:index`를 읽어 관련 페이지 후보 추림.
  2. 해당 페이지 본문 lazy fetch.
  3. 인용 포함 답 생성. 답 안에 출처 페이지 링크 표시.
  4. 답하면서 새로 알게 된 사실이 있으면 `suggestNewPage` 또는 기존 페이지 append로 환류 (ingest와 같은 review 경로 재사용).

**우리 맥락 고려**
- 채팅이 이미 있으니 새 화면 만들 필요 없음. 채팅 thread 안에서 모드 토글 또는 슬래시 커맨드로 진입.
- 위키 페이지가 적은 초기엔 답이 부실할 것 → 폴백으로 일반 chat 답으로 떨어지는 경로 필요.

---

### 3.3 Lint 동작 추가 — 우선순위 6

**Karpathy 원형**
- 주기적 헬스체크. 모순(같은 사실 다르게 적힘), stale(오래돼서 더 이상 참 아님), orphan(아무도 안 가리키는 외톨이 페이지), 지식 공백(자주 묻는데 페이지 없음) 탐지.

**현재 우리 코드**
- 없음. ADR 2026-05-08도 "stale proposal TTL 없음, dedup 없음" 명시.

**무엇을 만든다**
- 주 1회 백그라운드 LLM 호출. 별도 시스템 프롬프트: "모순/stale/orphan 후보를 찾아 표시하라."
- 결과 처리 방식:
  - 의심 항목은 해당 위키 페이지에 `proofFlagged` 마크로 stamp (이미 스키마 있음).
  - 요약은 `wiki:log`에 append.
  - 외톨이 페이지는 별도 섹션으로 사이드바에서 시각화.

**우리 맥락 고려**
- Tauri 데스크톱 앱이라 cron이 아니라 앱 실행 시점 / idle 시점 트리거.
- 사용자가 의도적으로 외톨이 페이지를 둘 수 있음 (개인 메모) → orphan은 경고일 뿐 자동 정리는 절대 금지.

---

### 3.4 cross-link 압력 추가 — 우선순위 3

**Karpathy 원형**
- 위키는 그래프. 페이지끼리 명시적으로 서로 참조해야 누적의 가치가 살아남.

**현재 우리 코드**
- 코드에 wikilink 플러그인 5개 존재 (`wikilinkBrokenPlugin`, `wikilinkClickPlugin`, `wikilinkPalettePlugin`, `wikilinkSyncPlugin`, `WikilinkPalette.tsx`). `[[name]]` 문법은 동작.
- 그러나 ingest 시스템 프롬프트는 `[[link]]` 사용을 시키지 않음. 결과: 평면 페이지들의 silo.

**무엇을 만든다**
- `apps/writer-tauri/src/agent/ingest.ts`의 `SYSTEM_PROMPT_STATIC`에 한 줄 추가: "기존 위키 페이지 title이 content에 등장하면 `[[name]]` 으로 링크 걸 것."
- 프롬프트에 현재 페이지 title 목록을 명시적으로 전달 (LLM이 "어떤 이름이 위키에 있는지" 알아야 링크 가능).

**우리 맥락 고려**
- daily 노트에서도 `[[name]]`이 동작하는지 확인 필요. ingest 결과가 위키 페이지로 들어가면 자동으로 wikilink 렌더링되지만, 사용자가 직접 쓴 daily 텍스트도 동일하게 동작해야 일관성 있음 (현재 어떻게 되는지 확인 후 조정).

---

### 3.5 위키 ingest를 마크 시스템에서 분리 — 우선순위 1 (가장 큰 정공)

**Karpathy 원형**
- ingest는 그냥 markdown 파일 갱신. 검토 UI는 별도. proof-sdk 같은 마크 개념 없음.

**현재 우리 코드 — 5가지 우회**
1. `lastWordAnchor()` (`apps/writer-tauri/src/agent/applyIngest.ts:122`) — proof-sdk가 "기존 텍스트에 마크 박아라"라고 강제하니 의미 없는 마지막 단어를 anchor로 사용.
2. `ensureAnchorViaTransaction()` (line 106) — 페이지가 비어 있으면 마크 박을 단어가 없으니 일부러 페이지 제목을 paragraph로 seed. **빈 페이지에 가짜 텍스트를 먼저 박는 우회**.
3. PM transaction + Y.Map 이중 쓰기를 `ydoc.transact` 안에 묶어 atomic 보장 (ADR 2026-05-10).
4. multi-block content는 PM에 못 박음 (proof-server drift 검출) → `Decoration.widget`으로 클라 전용 렌더링. 사용자 텍스트 선택 불가, pre-accept 편집 불가.
5. cross-doc 큐 (`ingestStore`) + `useApplyPendingMarks` lazy materialize. proof-sdk는 "마크는 PM doc에 박힌 시점에 존재" 가정인데 우리는 cross-doc 비동기라 별도 큐 필요.

**무엇을 만든다**
- ingest proposal을 위키 페이지 상단 banner/inbox 컴포넌트로 분리. PM 마크 아님.
- banner는 위키 페이지 진입 시 "검토할 제안 N건" 표시. 각 항목에 Accept / Reject 버튼.
- Accept = parser(content) → PM Fragment → 페이지 끝에 insert. Reject = inbox 항목 제거만.
- proofSuggestion 마크 시스템은 인라인 댓글/제안 본연 용도로만 사용 (글 쓰는 중 특정 범위에 대한 AI 제안).

**우리 맥락 고려**
- 기존 inline ghost preview UX는 사라짐. 트레이드오프 수용: 사용자가 페이지 어느 위치에 들어갈지 미리 보는 대신, banner에서 명시적 검토 → accept 시 페이지 끝에 추가.
- 위치 결정 정확도가 중요하면 추후 banner 안에서 "어디에 넣을지" 드롭다운(섹션 선택) 추가 가능.
- 5가지 우회 중 1·2·4·5가 거의 다 사라짐. 3은 "댓글/제안 마크"용으로 본래 위치에 잔존.
- 코드 변경 범위가 가장 큼: applyIngest.ts 대대적 단순화, markDecoPlugin의 INSERT 분기 제거, 새 BannerInbox 컴포넌트, `wiki` 페이지 컴포넌트 진입점에 banner 마운트.

---

### 3.6 wiki:log dedup — 우선순위 7

**Karpathy 원형**
- 로그는 append-only지만, 같은 사실이 반복 기록되지 않게 ingest 단계에서 dedup이 암묵적으로 수행됨 (LLM이 이미 위키에 있는지 보고 판단).

**현재 우리 코드**
- `readWikiContext()`가 `wiki:log`의 마지막 30줄만 프롬프트에 포함 (`LOG_TAIL_LINES = 30`).
- 31번째 줄 이상 떨어진 사실은 ingest가 모르고 다시 제안할 수 있음.
- ADR 2026-05-08 명시: "dedup 없음."

**무엇을 만든다**
- ingest 호출 직전, 이번 daily 노트 내용에 대해 별도 dedup 패스. 방법 후보 둘:
  - (a) LLM에게 명시적으로 "다음 제안이 위키에 이미 있는 사실인지 확인" 한 패스 추가.
  - (b) 임베딩 기반 후처리. proposal content를 기존 위키 페이지 라인들과 코사인 유사도 비교.

**우리 맥락 고려**
- (a)는 LLM 호출 1회 추가 → 지연/비용 증가. (b)는 임베딩 인프라 필요 → 외부 의존성 증가.
- 초기엔 (a)로 시작, 사용량 늘면 (b)로 전환.
- 5번(banner inbox)이 먼저 들어가면 사용자가 banner에서 "이미 있는 내용 같음" 직접 reject할 수 있어 dedup 부담이 낮아짐 → 5번 후 우선순위 재평가.

---

### 3.7 daily 재정리 신호 — 우선순위 5

**Karpathy 원형**
- 원본은 불변 가정. 같은 파일이 수정되면 별도의 "source updated" 이벤트로 처리.

**현재 우리 코드**
- daily가 동시에 사용자 글쓰기 화면 + ingest 원본 → 사용자가 ingest 후 daily를 수정해도 자동 재처리 없음.
- ingest 트리거가 어떻게 발화되는지 명시적 정책 없음 (idle / 명시적 명령 / 사용자 액션).

**무엇을 만든다**
- `KnownDoc`에 `lastIngestedAt` 메타 추가 (`apps/writer-tauri/src/state/docsStore.ts`).
- ingest 트리거 로직: 노트의 `updatedAt > lastIngestedAt` 인 경우만 후보로 선정.
- 재정리 시 LLM에게 "이전 ingest에서 추가된 내용은 이미 위키에 있다" 컨텍스트 전달 (dedup과 연동).

**우리 맥락 고려**
- daily는 며칠에 걸쳐 계속 수정될 수 있음 (오늘 적은 거 내일 또 추가). 매 수정마다 ingest 트리거하면 노이즈 → debounce / idle 후 일정 시간 경과 등 조건 필요.
- "이미 ingest된 내용은 표시"가 가능하면 사용자가 어디까지 처리됐는지 시각적으로 알 수 있음 (예: ingest된 라인은 흐릿하게).

---

### 3.8 schema leakage 정리 — 우선순위 8

**Karpathy 원형**
- 운영 규약은 `CLAUDE.md` 하나에 모임. 코드엔 wire-format invariant만.

**현재 우리 코드**
- `apps/writer-tauri/src/agent/ingest.ts`의 `SYSTEM_PROMPT_STATIC`에 스타일 룰이 일부 박혀 있음: "Be concise. Each proposal's content is one bullet line or short block." 등.

**무엇을 만든다**
- 스타일 룰은 `wiki:conventions`의 `DEFAULT_CONVENTIONS`로 이동.
- `SYSTEM_PROMPT_STATIC`은 wire-format invariant만 잔존: APPEND ONLY, JSON shape, target verbatim, log entry 필수.

**우리 맥락 고려**
- 작은 cleanup이라 단독 PR 가치는 낮음. 다른 항목 작업 중 곁가지로 처리하는 게 효율적.

---

## 4. 우선순위 (반복)

1. **5번 — 위키 ingest를 마크 시스템에서 분리**: 가장 큰 정공. 5가지 우회 제거. 후속 작업의 토대.
2. **1번 — 목차 페이지 도입**: 스케일 대비. 5번 끝나면 banner inbox에서 어느 페이지로 갈지 결정할 때도 index가 유용.
3. **4번 — cross-link 압력**: 한 줄짜리 프롬프트 변경. 그래프성 회복.
4. **2번 — Query 동작**: 위키 누적 가치를 닫는 loop.
5. **7번 — daily 재정리 신호**: 메타 1개 + 트리거 조건. 작은 추가.
6. **3번 — Lint**: 운영 안정성. 위키가 어느 정도 누적된 후 가치 발현.
7. **6번 — log dedup**: 5번 들어간 후 우선순위 재평가.
8. **8번 — schema leakage**: 곁가지 cleanup.

---

## 5. 작업 가드레일

- 각 항목은 별도 ADR로 결정 시점에 기록 (`docs/adr/`).
- 위키 데이터(특히 `wiki:custom-*` 페이지들)는 사용자 자산이므로 마이그레이션 시 반드시 비파괴 경로 (rollback 가능).
- 5번 작업 시 기존 proofSuggestion 마크가 박힌 위키 페이지들이 있다면 일괄 reject 후 banner inbox로 재발화하는 마이그레이션 필요. ADR 2026-05-08도 "기존 enqueue된 마크는 reject로 정리해야 함" 언급 있음.
- proof-sdk 계약 (3가지 편집 모델 절대 섞지 않기)은 그대로 유지. 5번이 그 계약을 더 깔끔하게 지키는 방향.
