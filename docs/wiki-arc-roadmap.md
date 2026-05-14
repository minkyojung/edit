# Wiki / Ingest 코드 구조 개선 로드맵 — 5 Arcs

작성: 2026-05-14

이 문서는 writer-tauri 의 위키 / ingest 파이프라인이 **proof-sdk 의 표준 기능을 우회하는 자체 구현** 4 개로 인해 표면 버그가 발생한다는 분석에서 시작한다. proof-sdk 와의 정렬을 5 개 독립 Arc 로 분해하고, 의존 순서대로 점진 마이그레이션하는 계획.

---

## Context

### 표면 증상 → 구조적 원인 추적

지금까지 발견한 사용자 가시 버그들:

| 표면 | 원인 |
|---|---|
| 위키 페이지 본문에 같은 줄 N번 박힘 | `IngestProposal.content: string` 자유 markdown → LLM 이 페이지 헤더 emit → 그대로 append |
| 자동 트리거 후 "no durable content" 누적 | 자동 polling 으로 작은 컨텍스트 LLM 호출 → 보수적 판정 + 매 pass 로그 1줄 |
| "서버가 가끔 마크 되돌림" 류 미묘한 bug | 직접 Yjs 쓰기로 mark mutation → 서버 projection 정합성 깨짐 → split-tr 우회 코드 누적 |
| AI attribution 이 텍스트 편집 후 부정확 | char offset 기반 anchor → 텍스트 변경 시 위치 drift |

이 4 개가 공통적으로 **proof-sdk 의 표준 기능을 자체 구현으로 우회한 결과**.

### 기술 stack 결정 (확정)

- **proof-sdk + Yjs + Milkdown**: live truth. user + AI 실시간 co-authoring 의 핵심 자산.
- **Git**: 미래 보조 (history/backup). 핵심 storage 는 아님.

이 stack 위에서 **SDK 기능을 더 깊이 활용** 하는 방향으로 정렬.

---

## proof-sdk Integration 감사

SDK 가 제공 vs 우리 코드의 현황:

| 기능 | SDK 제공 | 우리 현황 | gap |
|---|---|---|---|
| Mark 타입 정의 (proofAuthored, proofSuggestion 등 6종) | ✅ schema 정의 | ✅ 사용 중 (`editor/markTypes.ts`, `editor/proofMarkSchemas.ts`) | 없음 |
| **Semantic anchoring** (content/anchor/quote/pattern selector) | ✅ v2 표준 | ❌ **char offset 수동 계산** (`editor/utils/textRange.ts` + `agent/applyProposal.ts:111-130`) | 큰 부채 |
| **`/ops` endpoint** (typed mutation API) | ✅ 14 ops | ❌ **정의는 했지만 UNWIRED** (`lib/proofClient.ts:99-117`) — 직접 Yjs 쓰기로 우회 | 큰 부채 |
| **3축 provenance** (origin × basis × review) | ✅ v2 표준 | △ **2축** (proofAuthored + 사이드카 AuthoredMeta) | 중간 부채 |
| **Agent bridge** (14 REST 라우트) | ✅ /bridge/* | ❌ **0개 사용** — runIngest 가 자체 LLM 호출 + 자체 큐 | 큰 부채 (장기) |
| **Quote-to-anchor resolution** | ✅ ContentAnchor/QuoteAnchor | ❌ **자체 구현** (`buildTextIndex`, `resolveQuoteRange`, `mapTextOffsetsToRange`) | 큰 부채 |
| Yjs CRDT live | ✅ | ✅ 사용 중 | 없음 |
| Milkdown/PM 통합 | ✅ `@proof/editor` | ✅ 사용 중 | 없음 |

**핵심 통찰**: 4 개의 우회 자체 구현이 표면 버그의 근원. SDK 정렬 = 구조적 부채 청산.

---

## 5 개 Arc

각 Arc 는 독립 PR / 독립 phase. 의존 순서대로 정렬.

```
Arc 1 (Schema 좁히기)
   ↓ 깨끗한 데이터 모델 위에서
Arc 2 (/ops 마이그레이션)
   ↓ 표준 mutation API 위에서
Arc 3 (Semantic anchoring)
   ↓ 의미 기반 마크 위에서
Arc 4 (3축 provenance)
   ↓ 마크가 SDK 표준 형식이 된 후
Arc 5 (Agent bridge — 장기)
```

---

### Arc 1 — Proposal Schema 좁히기

**문제**: `IngestProposal.content: string` 이 자유 markdown. LLM 이 페이지 이름 (`## People`) + entity 이름 (`### Sarah`) + bullets 통째로 emit → 그대로 append → 페이지 본문에 "People" 헤더 누적.

**원인**: schema 자체가 헐거워서 잘못된 데이터를 받을 자리가 있음.

**원칙**: *Make illegal states unrepresentable*.

**해결**: `content: string` → `entity?: string + bullets: string[]`. 페이지 이름이 들어갈 통로 자체 제거.

```ts
// 지금
interface IngestProposal {
  target?: string
  content: string         // 자유 markdown
  ...
}

// 바꾼 후
interface IngestProposal {
  target?: string
  entity?: string         // "Sarah" — 헤더 마커 X
  bullets: string[]       // ["AI 팀 이동", "Voice 일함"]
  ...
}
```

Apply 레이어가 `entity + bullets → ### Sarah\n- ...` 로 조립. LLM 이 페이지 이름 emit 할 수 있는 통로 없음.

**범위** (변경 파일 6):
- `sidecar/src/server.mjs` — zod schema 갱신
- `src/agent/ingest.ts` — types + sanitizer + system prompt
- `src/state/ingestStore.ts` — PendingProposal persist v2→v3 migrate
- `src/lib/markdownAppend.ts` — `stitchProposalMarkdown` 헬퍼 신규
- `src/layout/WikiPageBanner.tsx` — acceptProposal + ProposalCard 재설계
- `src/layout/IngestProposalCard.tsx` — extractTitle 갱신
- `src/hooks/useIdleTrigger.ts` — materializeNewPageProposals 갱신

**Banner UI 재설계** (실리콘밸리 PM 4 결정):
1. **rendered preview** (raw JSON X)
2. **subtle 새/기존 entity 구별**: `＋ Bob` (새) vs `↳ Sarah` (기존)
3. **bullet 단위 hover-reject**: 각 bullet 옆 `✕` on hover. default 통째 Accept.
4. **inline edit 없음**: banner 는 결정 surface. 편집은 위키 페이지에서.

**비용**: 1.5~2 시간.

**가치**: 사용자 가시 버그 해결 + UI 명확성 + Arc 2~4 위한 깨끗한 기반.

---

### Arc 2 — `/ops` Endpoint 마이그레이션

**문제**: 마크 mutation 이 직접 Yjs 쓰기로 처리됨 → 서버 projection 이 가끔 reverts → 코드에 split-tr / "server quietly reverts" 우회 패턴 누적.

증거:
- `editor/markActions.ts:40-47` 의 "split-tr... because the server's drift detector misreads composite local writes" 코멘트
- `agent/applyProposal.ts:61` 의 우회 코드

**해결**: `proofClient.ops()` (이미 정의됨, line 99-117) 를 사용처에 wire. 마크 mutation 이 SDK 의 typed API 통과.

**범위**:
- `editor/markActions.ts` (acceptMark, rejectMark) → `ops()` 호출
- `layout/WikiPageBanner.tsx acceptProposal` → `ops()` 호출 + Yjs transact 제거
- `agent/applyProposal.ts` → 동일
- split-tr / 우회 코드 제거

**비용**: 2~3 시간.

**가치**:
- "서버가 가끔 되돌림" 버그 클래스 전체 제거
- 코드 -50 줄
- SDK 표준 mutation path 사용 → 미래 SDK 업데이트 호환

---

### Arc 3 — Semantic Anchoring 도입

**문제**: 마크 anchor 가 char offset 기반. 텍스트 변경 후 마크가 엉뚱한 곳에 붙거나 사라짐. `textRange.ts` 의 `buildTextIndex` / `resolveQuoteRange` 가 SDK 의 `ContentAnchor`/`QuoteAnchor` 재구현.

**해결**: 마크 stamp 시 char offset 대신 SDK 의 semantic selector 사용 (content/anchor/quote/pattern). 마크가 "의미" 따라감 — "Sarah is reporting" 텍스트에 anchor → 사용자가 "Sarah is now reporting" 으로 수정해도 따라감.

**범위**:
- `agent/applyProposal.ts:111-130` 의 quote resolution → SDK 의 quote selector API
- `editor/utils/textRange.ts` 폐기 (SDK 가 대체)
- Banner accept 시 `proofAuthored` mark 에 selector 정보 저장

**비용**: 2~3 시간.

**가치**:
- 마크 끈질김 폭증 (proof-sdk 의 핵심 자산 활성화)
- 사용자 편집 후 AI attribution 흔적 안전
- `textRange.ts` 폐기로 코드 -100 줄

---

### Arc 4 — 3축 Provenance 채택

**문제**: AuthoredMeta sidecar (`Y.Map('authoredMeta')`) 가 우회 패턴. proofProvenance 마크는 schema 에 존재하지만 origin/basis/review 필드 채워지지 않음.

증거:
- `hooks/useCollabDoc.ts:110-124` 의 AuthoredMeta 인터페이스 — sourceSlug/Label/Quote 만 저장, origin/basis 없음
- `editor/proofMarkSchemas.ts:393-473` 의 proofProvenance — schema 정의는 있지만 stamp 만 됨

**해결**: 마크 attr 에 직접 SDK 표준 3축 저장:
- **origin**: human / ai
- **basis** (AI 만): described / inferred / suggested
- **review**: status stack (multi-reviewer)

AuthoredMeta sidecar 점진적 폐기.

**범위**:
- `editor/proofMarkSchemas.ts` 의 proofProvenance attr 확장
- 서버 proof-server 가 이 attr canonicalize 하도록 (SDK 의존성 확인 필요)
- `hooks/useCollabDoc.ts:110-124` AuthoredMeta deprecate
- 기존 AuthoredMeta 데이터 마이그레이션 (Y.Map → mark attrs)

**비용**: 3~4 시간 (서버 의존성에 따라 늘어남).

**가치**:
- SDK provenance v2 와 완전 정렬
- AuthoredMeta sidecar 제거 → 코드 단순
- 서버가 마크 인식 → drift detector 우회 안 함

---

### Arc 5 — Agent Bridge 통합 (장기)

**문제**: `runIngest` 가 자체 LLM 호출 + 자체 큐 + 자체 apply. SDK 의 agent bridge (14 REST 라우트) 와 평행 시스템.

**해결**: 위키 ingest 가 SDK 의 표준 라우트 사용:
- `/bridge/marks` (마크 CRUD)
- `/bridge/suggestions` (제안 흐름)
- `/bridge/rewrite` (덩어리 교체)
- `/events/pending` (변경 이벤트)

LLM proposal → SDK 의 suggestion → SDK 의 apply → SDK 의 provenance.

**범위**: ingest 파이프라인 거의 전체:
- ingestStore 의 PendingProposal 큐 폐기 (SDK 가 suggestion lifecycle 관리)
- Banner UI 가 SDK 의 suggestion API 사용
- runIngest 가 SDK 의 agent loop 사용

**비용**: 1주+. 큰 refactor.

**가치**: SDK ecosystem 완전 통합. 다른 SDK 사용 앱들과 패턴 일치.

**판단**: Arc 1~4 끝낸 후 1~3 개월 운영 + SDK 의 bridge API 안정성 확인 후 결정. 단기 ROI 낮음 — Arc 1~4 가 더 시급.

---

## 추천 순서

| 우선 | Arc | 비용 | 누적 효과 |
|---|---|---|---|
| **1** | Schema 좁히기 | 1.5~2h | 표면 버그 해결, UI 명확화, 깨끗한 기반 |
| 2 | /ops 마이그레이션 | 2~3h | 우회 코드 제거, 서버 정합성 확보 |
| 3 | Semantic anchoring | 2~3h | 마크 끈질김 ↑, textRange 폐기 |
| 4 | 3축 provenance | 3~4h | AuthoredMeta 폐기, SDK 완전 정렬 |
| (5) | Agent bridge | 1주+ | (장기 — 별도 평가) |

**Arc 1~4 합쳐 9~12 시간으로 코드 구조 본격 정렬**. 한 Arc = 한 PR.

---

## 검증 원칙

각 Arc 끝나면:
1. **빌드**: `pnpm exec tsc --noEmit` + `pnpm exec eslint <changed>` → 0 errors
2. **사용자 시나리오** (Arc 별 별도): 정상 경로 + 회귀 검증
3. **사용자 가시 효과 확인**: 표면 버그 사라짐 + 코드 라인 수 감소

---

## Arc 1 진행 상태 — 즉시 시행 예정

이 문서 작성 후 첫 작업. 상세 작업 분해는 `~/.claude/plans/b-merry-pebble.md` 참고.

---

## 한 줄

**proof-sdk 가 이미 푼 4 개 문제 (anchor 안정성, /ops, 3축 provenance, agent bridge) 를 우회한 자체 구현이 표면 버그의 근원. 5 개 Arc 로 점진 정렬. Arc 1~4 = 9~12 시간 = 코드 구조 본격 정렬. Arc 5 는 장기**.
