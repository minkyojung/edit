# Phase 6 — Wiki LLM 완성

**기간**: 2.5주 (5개 sub 합산)
**선행**: Phase 5 완료 (또는 Phase 4 만 완료 — "대안 순서" 시 6.1 만 먼저)
**목적**: Karpathy 패턴에서 우리 구현이 빠뜨린 부분 채움. 위키가 ingest-only 가 아닌 ingest + query + lint 의 완전 사이클로.

## 배경

Karpathy 의 LLM Wiki 패턴은 5개 축:
1. **Ingest** — 사용자 글 → 위키 갱신 ✓ 구현됨 (`agent/ingest/`)
2. **Index** — 페이지별 한 줄 요약 ✓ 구현됨 (`system:index` 페이지)
3. **Log** — ingest 이력 ✓ 구현됨 (`system:log` 페이지)
4. **Conventions** — 위키 규칙 ✓ 구현됨 (`system:conventions` 페이지)
5. **Query** — 위키 검색 ✕ **미구현 — 6.1**
6. **Lint** — 위키 품질 점검 ✕ **미구현 — 6.2**
7. **시간 메타** — 페이지별 updatedAt ✕ 부분 — **6.4**
8. **링크 사전검증** — `[[Page]]` 가 실재하는지 ✕ **6.3**
9. (선택) 관계 타입 — `[[Page|depends-on]]` ✕ **6.5**

이 phase 의 본질: AI 가 만든 위키 메모리가 다시 AI 에게 입력으로 돌아오는 **피드백 루프 완성**. 지금은 ingest 가 한 방향만 흐름.

## Sub 6.1 — agent/queryWiki (1.5주)

### 무엇
사용자가 위키에 질문 → LLM 이 index 검색 → 관련 페이지 본문 읽기 → 답변 합성 → "이 답을 위키 페이지로 정리하시겠어요?" 후속 제안.

### 왜 가장 먼저
- Karpathy 패턴의 핵심 ("explorations compound in knowledge base rather than disappearing into chat")
- 지금은 chat 으로 물어보면 그 답이 어디에도 안 남음
- 위키가 AI 메모리로서 가치 있게 됨

### 구현

#### 파일
- 신규: `apps/writer-tauri/src/agent/queryWiki.ts`
- 신규: UI 진입점 — Command Palette (`Cmd+Shift+P → "Ask wiki"`) + 사이드바 또는 chat panel 안 슬래시 (`/ask`)

#### 흐름
1. 사용자 질문 입력 (예: "Sarah 가 무슨 책 읽고 있더라?")
2. queryWiki 가 system prompt 에 INDEX 블록 전체 + CONVENTIONS 본문 포함
3. LLM 이 검색 (어떤 페이지를 봐야 하는지 결정)
4. tool `read_wiki_page(typeId)` 호출 → 페이지 본문 받음
5. 충분한 정보 모으면 답변 합성 + tool `submit_query_answer({ answer, citations, suggestedUpdates })` 호출
6. 결과 UI:
   - 답변 본문 (citations 클릭 시 해당 위키 페이지로 이동)
   - "이 답을 위키 페이지로 정리" 버튼 → ingest 와 같은 흐름으로 큐에 push

#### Tool 정의
```ts
read_wiki_page: {
  name: 'read_wiki_page',
  description: 'Read the full body of a wiki page by its type id.',
  input_schema: { typeId: 'string' },
}

submit_query_answer: {
  name: 'submit_query_answer',
  description: 'Final answer + citations + optional follow-up updates.',
  input_schema: {
    answer: 'string',
    citations: 'array of { typeId, quote }',
    suggestedUpdates: 'array of IngestProposal',  // optional
  },
}
```

### 검증
- 위키에 질문 → 관련 페이지 인용한 답변
- 답변에 citation 표시 + 클릭 시 페이지 이동
- "위키에 정리" 클릭 → 새 페이지 또는 기존 페이지 업데이트 제안 큐로 (ingest 와 같은 banner UI 흐름)

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

- [ ] queryWiki 동작 (Sub 6.1)
- [ ] lint 동작 (Sub 6.2)
- [ ] 링크 사전검증 동작 (Sub 6.3)
- [ ] 시간 메타 동작 (Sub 6.4)
- [ ] (선택) 관계 타입 동작 (Sub 6.5)
- [ ] `ensureSystemPage` 3번 복붙 → 한 헬퍼로 정리 (wikiService.ts 의 구조 냄새 해소)
- [ ] Phase 2~5 회귀 테스트 모두 통과

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
