# Phase 6 — Wiki LLM 완성

**기간**: 2.5주 (5개 sub 합산)
**선행**: Phase 5 완료 (또는 Phase 4 만 완료 — "대안 순서" 시 6.1 만 먼저)
**목적**: Karpathy 패턴에서 우리 구현이 빠뜨린 부분 채움. 위키가 ingest-only 가 아닌 ingest + query + lint 의 완전 사이클로.

## 진행 현황 (2026-05-23)

| Sub | 내용 | 상태 |
|---|---|---|
| 6.1 | Query 동작 — 양방향 환류 채널 | ✅ 완료 (`1613066b` + `e1ae27fc`) |
| 6.2 | Lint 동작 | ⏳ 미진행 |
| 6.3 | 링크 사전검증 | ⏳ 미진행 |
| 6.4 | 시간 메타 | ⏳ 미진행 |
| 6.5 (선택) | 관계 타입 라벨 | ⏳ 미진행 |

**다음 진행 권장**: 6.3 + 6.4 묶음 (며칠 + 며칠 = 1주 미만 한 PR). 이유는 본문 §"다음 작업 권장" 참고.

## 배경

Karpathy 의 LLM Wiki 패턴은 5개 축:
1. **Ingest** — 사용자 글 → 위키 갱신 ✓ 구현됨 (`agent/ingest/`)
2. **Index** — 페이지별 한 줄 요약 ✓ 구현됨 (`system:index` 페이지)
3. **Log** — ingest 이력 ✓ 구현됨 (`system:log` 페이지)
4. **Conventions** — 위키 규칙 ✓ 구현됨 (`system:conventions` 페이지)
5. **Query** — 위키 검색 ✅ 구현 완료 (6.1)
6. **Lint** — 위키 품질 점검 ✕ **미구현 — 6.2**
7. **시간 메타** — 페이지별 updatedAt ✕ 부분 — **6.4**
8. **링크 사전검증** — `[[Page]]` 가 실재하는지 ✕ **6.3**
9. (선택) 관계 타입 — `[[Page|depends-on]]` ✕ **6.5**

이 phase 의 본질: AI 가 만든 위키 메모리가 다시 AI 에게 입력으로 돌아오는 **피드백 루프 완성**. 6.1 완료로 루프는 닫혔다 — 남은 sub 들은 위키 품질과 노이즈 관리.

## Sub 6.1 — Query 동작 ✅ 완료 (2026-05-23)

원래 계획은 `agent/queryWiki.ts` 신규 + `submit_query_answer` 구조화 tool
이었지만, 탐색 중 **80% 이미 구현돼 있음**을 발견. 빠진 한 조각만
채우는 방향으로 재설계 후 완료.

### 이미 있었던 것 (탐색 결과)

| 6.1 요구사항 | 실제 위치 |
|---|---|
| 질문 입력 진입점 | `/chat/commands/builtin/ask.md` (`/ask` slash) |
| INDEX + CONVENTIONS 자동 주입 | `agent/chat/systemPrompt.ts` `composeSystemBlocks` |
| 페이지 본문 능동 fetch | sidecar `read_page` / `search_wiki` 도구, chat 기본 활성 |
| 답변 + citation (`[[Title]]`) | `FREE_CHAT_PROMPT` 의 Citations 룰 |

위키 → 답 방향은 일반 채팅에서도 동작 — `/ask` 가 아니더라도
모든 채팅이 위키 컨텍스트를 본다.

### 추가한 것 (이 PR 의 핵심)

**1. 채팅 → 위키 환류 채널** (커밋 `e1ae27fc`)

기존 `runIngestCore` 를 그대로 재사용해 채팅 답변 본문을 source 로 다룸:

- `agent/wikiHandoff.ts` — `runChatToWikiHandoff(messageContent, threadId, threadTitle)` 함수.
  `runIngestCore({ text, sourceLabel: 'chat: <title>' })` 호출 후 결과를
  `ingestStore.enqueue(...)` 로 push. 기존 banner UI 가 그대로 검토 surface.
- `chat/messages/FileToWikiButton.tsx` — 어시스턴트 메시지 hover 시 노출되는
  책 아이콘. 클릭 시 위 함수 호출 + 토스트 결과.
- `chat/messages/MessageFooter.tsx`, `MessageRow.tsx`, `layout/ChatPanel.tsx` —
  `threadId` / `threadTitle` prop drilling.
- `lib/notify.ts` — `chatHandoffQueued` / `chatHandoffEmpty` /
  `chatHandoffMalformed` / `chatHandoffFailed` 토스트 4종.
- `agent/ingest/prompts.ts` `buildPrompt` — `sourceLabel.startsWith('chat:')`
  분기 한 줄로 "chat reply 는 narrative 빼고 durable facts 만" nudge.

**2. 사족 정리** (커밋 `1613066b`)

채팅 자동 ingest 흐름을 제거 — Karpathy 원본의 "Raw Sources" 정의에
채팅은 포함되지 않으며, 우리 코드의 자동 thread compaction 은 비용
(1 + N LLM 호출) 대비 가치가 작았다.

- 삭제: `agent/selectActiveThreadsForIngest.ts`, `agent/compactChatThread.ts`
- 정리: `IngestCoreArgs` 에서 `sinceTs` / `threadSlug` 제거, `composeSystemPrompt`
  에서 `chatActivity` 파라미터 + "TODAY'S CHAT ACTIVITY" 블록 제거,
  `ThreadMeta.aiSummary` / `aiSummaryUpToTurnId` 제거.
- 효과: 약 250줄 감소, ingest 호출 1 + N → 1.

### 방식 결정 (왜 수동 트리거인가)

3가지 옵션 (A 수동 / B 구조화 / C 자동) 중 **A 채택**:
- 신호 vs 잡음 — 자동 환류는 잡담까지 다 큐에 쌓아 사용자 피로 ↑.
- Karpathy 원칙 "사람=판단, LLM=정리" 와 일치.
- 기존 ingest 흐름 그대로 재사용 → 코드 작음.
- 1~2주 데이터 관찰 후 B/C 격상 가능 (백트랙 비용 낮음).

원래 plan 파일: `~/.claude/plans/starry-booping-turing.md`.

### 검증
- `pnpm exec tsc --noEmit` 0 errors.
- `pnpm exec eslint` 0 errors on changed files.
- 수동: `/ask <q>` → 답에 `[[Title]]` 인용 → footer 책 아이콘 → 토스트
  → 위키 페이지 banner 카드 ✓/✕ 확인됨 (사용자 스크린샷).

### 남은 폴리시 (다음 PR 에서 같이 또는 별도)

- **Onboarding tooltip**: 책 아이콘 첫 등장 시 "이 답을 위키에 정리할 수
  있어요" 1회 안내. 지금은 아이콘이 hover-only 라 발견성 약함.
- **신호 로깅**: `[wikiHandoff] result` 한 줄 로그를 추가해서 1~2주 후
  자동 환류 (Option C) 격상 결정에 쓸 데이터 수집.
- **`/ask` 처리**: 지금은 그대로 유지. 일반 채팅도 위키 기반이라
  `/ask` 의 차별점은 "엄격 wiki-only 모드" 뿐. 사용 빈도 보고 결정.

## Sub 6.2 — agent/lint (1주)

### 무엇
주기적 (수동 트리거 + 주 1회 자동) 위키 헬스 체크:
- **Dead link**: `[[Page]]` 인데 페이지 없음
- **중복 entity**: 같은 인물이 두 페이지에 나뉨 (예: "Sarah" 와 "Sarah Kim")
- **Stale claim**: 수개월 안 건드린 페이지 + 사용자 daily 에 contradicting 내용
- **Orphan 페이지**: 어디서도 안 링크됨
- **빠진 cross-reference**: 페이지 A 가 B 언급하는데 링크 안 됨

### 결과
`system:lint` 페이지에 체크리스트로 리포트:
```markdown
## Lint Report — 2026-05-15

### Dead Links (3)
- [[Project X]] in [[Sarah]] — page doesn't exist
- ...

### Possible Duplicates (1)
- [[Sarah]] and [[Sarah Kim]] — same person?

### Orphan Pages (2)
- [[Old Notes]] — not linked from anywhere
...
```

사용자가 페이지 보며 하나씩 해결. 각 항목 옆 "Fix" 버튼 → 자동 제안 큐.

### 구현

#### 파일
- 신규: `apps/writer-tauri/src/agent/lint.ts`
- 수정: `apps/writer-tauri/src/state/wikiService.ts` — `system:lint` 시드 로직 (Phase 0 에서 시작된 `ensureSystemPage` 일반화로 같이 정리)

#### lint 종류별 구현
| Check | 구현 |
|---|---|
| Dead link | `wikilinkResolve` 와 모든 페이지의 wikilink 토큰 비교 → 미해결 수집 |
| 중복 entity | 페이지 제목 + index summary 의 fuzzy 유사도 (LLM 한 번 호출) |
| Stale claim | `updatedAt` (Sub 6.4) + 최근 daily 의 entity 언급 비교. LLM 호출. |
| Orphan | 모든 페이지의 incoming link 그래프 빌드 → 0 incoming 인 페이지 |
| 빠진 cross-ref | 페이지 본문에 다른 페이지 제목 plain text 로 나오는데 link 안 됨 → 후보 추출. LLM 검토. |

cheap check (dead link, orphan, 빠진 cross-ref 의 plain match) 는 로컬에서, 검토가 필요한 부분 (중복, stale, ambiguous) 만 LLM 호출.

### 검증
- 의도적으로 dead link 만든 후 lint → 리포트에 잡힘
- 같은 이름 entity 두 페이지 → 중복 후보로 잡힘
- orphan 페이지 → 잡힘
- "Fix" 클릭 → 적절한 자동 수정 제안

## Sub 6.3 — 링크 사전검증 (며칠)

### 무엇
AI 제안의 `bullets` 안에 `[[Page]]` 가 있을 때, 위키 catalog 와 대조 → 존재하면 그대로, 없으면 사용자에게 "이런 페이지 없습니다 — 만들까요? 무시할까요?" 확인.

### 왜
현재는 dead link 가 그대로 들어가서 렌더 시 깨진 텍스트로 보임.

### 구현
- 수정: `apps/writer-tauri/src/lib/wikilinkResolve.ts` — `findUnresolvedLinks(text): string[]` 추가
- 수정: `apps/writer-tauri/src/layout/WikiPageBanner.tsx` — 카드에 "unresolved links" 섹션. 각 링크 별로 "Create page" / "Remove link" 옵션.

### 검증
- LLM 이 존재하지 않는 페이지 멘션 → 사용자에게 확인 UI
- "Create page" 클릭 → `suggestNewPage` 흐름 트리거
- "Remove link" 클릭 → bullet 의 `[[Page]]` 를 `Page` (plain text) 로 변환 후 accept

## Sub 6.4 — 시간 메타 (며칠)

### 무엇
위키 페이지마다 `updatedAt` 메타 추적. Ingest 프롬프트에 "Sarah 페이지는 어제 갱신됨" 같은 컨텍스트 전달 → LLM 이 같은 사실 재제안 안 함.

### 왜
시간 인식 부재 → 같은 사실 반복 제안 → 사용자 피로.

### 구현
- 수정: `apps/writer-tauri/src/state/wikiService.ts` — 각 페이지의 Y.Doc meta map 에 `updatedAt` 자동 갱신 (PM doc 변경 시 hook)
- 수정: `apps/writer-tauri/src/agent/ingest/prompts.ts` — wiki 블록 헤더에 `[type-id — title — updated 5d ago]` 형식으로 포함

### 검증
- Y.Doc edit → meta.updatedAt 갱신
- 다음 ingest 패스 prompt 에 `updated Xd ago` 노출 확인
- 최근 갱신된 페이지에 LLM 이 중복 제안 안 함 (수동 시나리오)

## Sub 6.5 (선택) — 관계 타입 라벨 (1주)

### 무엇
`[[Page|depends-on]]`, `[[Page|contradicts]]` 같은 관계 타입 마크다운 확장. 렌더 시 배지로 표시. Graph 구조가 의미를 갖게 됨.

### 왜
Karpathy 가 명시한 "collapsed relationship types" 위험. 그러나 가치 검증 안 됨 → 선택.

### 구현
- 수정: `apps/writer-tauri/src/lib/wikilinkResolve.ts` — 파서에서 `|`-구분 파싱
- 수정: `apps/writer-tauri/src/editor/wikilinkClickPlugin.ts` 등 렌더 — 관계 타입에 따라 배지 색
- 수정: ingest prompt — 관계 타입을 활용할 수 있는 예시 추가

### 검증
- 사용자가 위키 페이지에 `[[Title|inspired-by]]` 작성 → 렌더 시 배지
- LLM 이 관계 타입 인식하고 ingest 시 활용

## 완료 기준 (Phase 6 전체)

- [x] queryWiki 동작 (Sub 6.1) — 2026-05-23
- [ ] lint 동작 (Sub 6.2)
- [ ] 링크 사전검증 동작 (Sub 6.3)
- [ ] 시간 메타 동작 (Sub 6.4)
- [ ] (선택) 관계 타입 동작 (Sub 6.5)
- [x] `ensureSystemPage` 3번 복붙 → 한 헬퍼로 정리 (wikiService.ts) — 이미 Phase 0~3 기간에 정리됨
- [ ] Phase 2~5 회귀 테스트 모두 통과

## 다음 작업 권장 (next branch)

**1순위: Sub 6.3 + Sub 6.4 묶음 PR** (며칠 + 며칠 = 1주 미만)

두 작업이 같은 영역 (ingest 프롬프트 + banner 카드) 을 건드리고, 각자
독립적이라 한 PR 로 묶기 자연스럽다.

- **6.3 링크 사전검증**: 사용자가 banner 카드를 보기 전, 시스템이
  proposal 본문의 `[[Page]]` 토큰을 catalog 와 자동 대조 → 미해결 링크는
  카드에 "Create page / Remove link" 옵션으로 노출. 사용자 클릭 한 번에
  처리. 깨진 링크가 위키에 박히는 일 0.
- **6.4 시간 메타**: 위키 페이지마다 `updatedAt` 추적, ingest prompt 의
  WIKI 블록 헤더에 `[type-id — title — updated 5d ago]` 형식으로 노출.
  "어제 막 정리한 사실을 오늘 또 제안" 패턴이 사라짐.

진입점: `lib/wikilinkResolve.ts` 의 `findUnresolvedLinks(text)` 신규 +
`WikiPageBanner.tsx` 의 카드 컴포넌트 + `state/wikiService.ts` 의
Y.Doc meta 갱신 hook + `ingest/prompts.ts` 의 WIKI 블록 헤더 포맷.

**2순위: 1~2주 신호 관찰**

6.1 의 책 아이콘 사용 패턴을 모아 6.1.next 결정:
- 클릭 빈도 / 환류 accept rate / Empty 비율
- 거의 항상 누름 → Option C (자동 환류) 격상 검토
- 거의 안 누름 → 기능 가치 재평가
- Empty 비율 높음 → `chat:` 분기 프롬프트 튜닝

데이터 수집을 위한 한 줄 로깅 (`[wikiHandoff] result …`) 을 6.3 PR
끄트머리에 같이 넣는 게 비용 0.

**3순위: Sub 6.2 Lint** (1주)

위키가 30~50 페이지 넘은 후 가치 발현 시점이라, 6.3/6.4 완료 후 위키가
좀 더 자란 시점이 적절. 일찍 하면 false positive 노이즈가 더 큼.

**보류: Sub 6.5 관계 타입**

가치 검증 안 됨. 6.2~6.4 끝낸 후 사용자 판단.

## 부수 효과 (구조 자동 개선)

## 부수 효과 (구조 자동 개선)

| 자동 단순화 | 어디 |
|---|---|
| `agent/` 모듈 균형 | ingest + query + lint 가 자연스러운 3개 묶음 |
| `wikiService.ts` 분리 | catalog 부분 vs system page 시드 부분 분리 |
| 위키 품질 자동 유지 | 사용자 수동 관리 부담 ↓ |

## 위험

| 위험 | 완충 |
|---|---|
| queryWiki 가 token 비용 많이 씀 (INDEX + 페이지 본문) | INDEX 만으로 답할 수 있는 질문은 페이지 안 읽음. 페이지 읽기는 LLM 의 명시적 tool 호출로만. cap 설정 (최대 5페이지). |
| lint 가 너무 많은 false positive 생성 → 사용자 피로 | LLM 검토 단계의 confidence threshold 설정. confidence 낮은 항목은 리포트에 "Possible" 로 분리 |
| 링크 사전검증 UI 가 ingest 흐름 끊김 | 검증을 background (제안 받은 직후 자동 실행) 으로. 사용자가 banner 클릭할 때 이미 검증 결과 표시 |
| 시간 메타가 잘못된 형식 (예: "5d ago" vs ISO timestamp) 로 LLM 혼동 | 인간이 읽기 쉬운 형식 ("yesterday", "3 days ago") 표준화 |
| 관계 타입 (Sub 6.5) 의 가치 검증 안 됨 | Sub 6.5 는 명시적으로 선택. 6.1~6.4 완료 후 사용자 결정 |

## 다음 단계 (Phase 6 이후)

Phase 6 끝나면 9주 로드맵 완료. 그 후 가능한 후속:

- 멀티 디바이스 sync 가 필요해지면 자체 작은 Hocuspocus 서버 (1~2주)
- Export 기능 재평가 (보류 중인 자산 cherry-pick — `.context/prototype-git-storage/` 의 검증된 round-trip 로직 활용)
- LLM 모델 비용 최적화 (캐시 hit ratio 측정 + 프롬프트 정리)
- 위키 graph 시각화 (관계 타입 6.5 했다면)
