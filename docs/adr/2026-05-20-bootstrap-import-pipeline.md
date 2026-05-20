# ADR: Bootstrap import 파이프라인 — source-agnostic core + 입구별 wrapper

작성: 2026-05-20
상태: **Superseded by `2026-05-20-profile-pipeline-rebuild.md` (2026-05-20 same-day rewrite)**
관련: `2026-05-08-wiki-ingest-system.md`, `2026-05-13-wiki-ingest-banner-inbox.md`
참고: `/Users/williamjung/.claude/plans/async-imagining-book.md` (Theme 3 — 1차 슬라이스 실행 계획)

> **2026-05-20 supersession note**: 이 ADR 의 모든 land 항목 (BootstrapDialog
> Stage 2, `runImport`, `bootstrapIngest`, `parseImport`, `extractProfile`)
> 은 같은 날 오후 전부 삭제되고 새 profile 파이프라인 (Source 어댑터 + LLM
> 섹션 호출 + zone 분리 wiki:profile) 로 대체됨. 사유와 새 설계는 후속
> ADR 참고. 이 문서는 history 로 남김.

---

## Context

v0.0.1 Theme 3 (Memory Bootstrap) 의 첫 출시 가치: **빈 wiki 로 시작하지 않게 한다**. 깨끗한 vault 로 첫 부팅한 사용자에게 첫 30 분의 코어 루프 (글 → 메모리화 → AI 활용) 를 보여줘야 함. 그러기 위해선 사용자의 기존 자료 (Obsidian 노트 / URL / 인터뷰 답변) 를 ingest 파이프라인에 흘려보낼 입구가 필요.

기존 자산:
- `runIngest(noteSlug)` — 데일리 노트 한 개를 입력으로 받아 LLM 호출, wiki 후보 proposals 반환. ingest 파이프라인의 유일한 진입점.
- `assembleContext` (Block A4) — wiki Tier 1/2 컨텍스트 조립. consumer 공통 facade.
- `selectActiveThreadsForIngest` (C'.3) — chat thread 압축 후 ingest 시스템 프롬프트에 합류.
- `ingestStore.enqueue({ proposals, sourceSlug, sourceLabel })` — 자유 문자열 sourceSlug/sourceLabel. daily 가정 없음.
- `WikiPageBanner` — proposals 검토 surface. source 무관하게 wiki 페이지 진입 시 그 페이지 매칭 proposals 렌더.

**문제**: `runIngest` 는 daily-specific 가정이 4 군데 박혀있어 그대로는 import 흐름에 못 씀.

| 위치 (`apps/writer-tauri/src/agent/ingest.ts`) | daily 가정 |
|---|---|
| ~line 561-572 | doc lookup + `isWikiDoc` 가드 (slug 기반) |
| ~line 585-611 | block-hash dedup (`pickNewBlocks` + `ingestedBlockHashes[noteSlug]`) |
| ~line 629 | `lastIngestedAt[noteSlug]` watermark — chat 압축 sinceTs |
| ~line 649-652 | `noteLabel = "daily/YYYY-MM-DD"` 형식 빌드 |

세 가지 대안:

1. **`runIngest` 시그니처 확장** — `{ noteSlug?, text?, skipDedup, sourceType }` 등 옵션 추가. 분기마다 if 문 증가, 시그니처 비대화.
2. **`bootstrapIngest` 안에 `runIngest` 본문 복붙** — LLM 호출 80 줄 중복. 프롬프트 갱신 시 두 곳 동기화.
3. **공통 코어 추출** — daily-specific 4 군데 제거한 source-agnostic 함수 신설, daily 와 bootstrap 둘 다 그 코어를 호출.

추가 결정 — pipeline 모듈 분할:

- **단일 파일** — `runImport` 안에 dialog + fs + 청크 + bootstrapIngest 모두. 짧지만 단위 테스트 어려움 (fs/dialog mocking 비용).
- **3-function split** — 순수 유틸 (`parseImport.ts`) + I/O orchestration (`runImport.ts`) + LLM wrapper (`bootstrapIngest.ts`). 단위 테스트 자연스러움, 재사용 (URL fetch B4 가 같은 청크 유틸 재사용).

마지막으로 — 실행 순서 결정. Theme 3 전체 (B1~B6) 는 6.5 d. 한 번에 다 land 할까, 끊어서 갈까?

- **한 번에 다 빌드** — UI 가 처음부터 완성. 하지만 6.5d 추측 작업이 누적되고 (Interview 질문 quality, Import 결과 noise level) 첫 dogfood 가 너무 큰 단위라 어디서 어긋났는지 진단 어려움.
- **1 차 슬라이스 → dogfood → 추가** — B3 (엔진) + B2 (가장 단순한 입구 Import) 만 먼저. 1 주 본인이 사용. 가치 검증 후 B4 (URL) / B5 (Interview) / B6 (재진입) 진행 여부 판단.

## Decision

세 결정 묶음:

### 1. `runIngestCore` 추출 — source-agnostic 공통 엔진

대안 3 채택. `runIngest` 의 LLM 호출 + 컨텍스트 조립 + 결과 파싱을 source-agnostic 함수로 추출.

```ts
// apps/writer-tauri/src/agent/ingest.ts (line ~555)
export interface IngestCoreArgs {
  text: string         // 이미 필터링된 입력 (daily 는 block-hash 통과분, bootstrap 은 chunk)
  sourceLabel: string  // "daily/2026-05-19" or "imported/notes.md"
  sinceTs: number      // chat 압축 watermark; bootstrap 은 0
  ydoc: Y.Doc | null   // chat 컨텍스트용; null 이면 chat 블록 omit
}
export interface IngestCoreResult {
  proposals: IngestProposal[]
  logEntry: string | null
  raw: string
  malformed: boolean
}
export async function runIngestCore(args: IngestCoreArgs): Promise<IngestCoreResult>
```

`runIngest(noteSlug)` 는 그대로 export. 내부에서 daily-specific 처리 (doc lookup, block-hash dedup, lastIngestedAt 갱신, noteLabel 빌드) 한 후 `runIngestCore` 호출하고 `ingestedHashes` 합쳐서 반환.

행동 변화 0 — `runIngest` 의 외부 시그니처 / 동작 동일. 126 기존 tests 통과.

### 2. 3-function pipeline split (`agent/import/`)

```
parseImport.ts          # 순수 유틸 (no state, no I/O)
  ├ stripFrontmatter(text)
  ├ chunkText(text, maxBytes = 50_000)
  └ inferSourceLabel(path)

runImport.ts            # I/O orchestration
  └ runImport({ onProgress })
       1. openDialog (multi-file picker)
       2. per-file: readTextFile → stripFrontmatter → chunkText
       3. per-chunk: bootstrapIngest (sequential per file, parallel across files)
       4. onProgress 콜백 + 누적 카운터

agent/bootstrapIngest.ts  # LLM wrapper
  └ bootstrapIngest({ text, sourceLabel, sourceSlug? })
       1. active doc 의 ydoc best-effort (null OK)
       2. runIngestCore({ text, sourceLabel, sinceTs: 0, ydoc })
       3. 결과를 ingestStore.enqueue 로 직접 push
```

세 모듈 분할 이유:

- **`parseImport`** — 순수 함수라 단위 테스트 자연스러움 (`parseImport.test.ts` 14 케이스, frontmatter / chunk 경계 / 한글 multibyte / Windows 경로). B4 (URL fetch) 가 fetched HTML→MD 후 `chunkText` 그대로 재사용.
- **`runImport`** — Tauri fs/dialog 의존 + 비동기 orchestration. 단위 테스트 비용 높아 e2e 로 대체 (BootstrapDialog Stage 2 가 호출 site). 실패 정책 명시 (per-file try/catch, 파일 간 Promise.all 병렬, 청크 내 sequential).
- **`bootstrapIngest`** — `runIngestCore` 의 thin wrapper. `sinceTs=0` + ydoc best-effort + 직접 enqueue 세 가지 bootstrap 결정만 가짐. B4/B5 가 같은 진입점 재사용.

### 3. 1차 슬라이스 (B3 → B2 → dogfood) 우선

플랜 문서의 알파벳 순서 (B1 → B2 → B3 → B4 → B5 → B6) 대신 의존성 그래프 기반 순서:

```
B1 (Dialog 껍데기, 이미 완료)
  ↓
B3 (bootstrapIngest 엔진 — 모든 입구의 출구)
  ↓
B2 (Import — 가장 단순한 입구, 첫 e2e)
  ↓
[dogfood gate — 1 주 본인 사용]
  ↓ (3 게이트 질문 통과 시)
B4 (URL fetch — 같은 엔진 재사용)
  ↓
B5 (Interview — wiki 데이터 있어야 의미)
  ↓
B6 (재진입 — Cmd+Shift+B)
```

이유:

- B2/B4 는 같은 출구 (`bootstrapIngest`) 로 수렴. **엔진 먼저 굳혀야 입구 추가가 안전**.
- 6.5 d 짜리 추측 작업 (Import 결과 품질, Interview 질문 quality) 은 위험. Import 만으로 1 주 dogfood → 가치 검증 후 추가 phase 확정.
- B5 (Interview) 는 wiki 데이터 위에서 빈 곳 찾는 형태. B2 결과 없이 디자인하면 추측 작업.

## Consequences

### 긍정

- **`runIngest` 외부 동작 동일** — 126 → 140 tests 통과 (+ parseImport 14). 회귀 0.
- **B4/B5/B6 가 같은 엔진 재사용** — URL fetch / Interview 가 추가 시 `bootstrapIngest` 호출만 하면 됨. 새 LLM dance 안 짜도 됨.
- **`parseImport.chunkText` 가 50KB byte 기준** — UTF-8 multibyte safe. Korean/emoji-heavy 입력에서 LLM 윈도우 초과 안 함.
- **첫 e2e 검증 결과** (2026-05-20):
  - Dialog → Import 체크 → Next → 파일 picker → 1 파일 선택
  - 토스트: "Imported 1 file — No new facts to extract"
  - 파이프라인 모든 단계 동작, 0-proposal 분기도 사용자에게 surface (notify.bootstrapImportComplete 의 4 분기 중 하나)
- **CLAUDE.md "Wellmade" 충족** — 0-proposal 결과도 silent 하지 않음. 사용자가 outcome 을 항상 인지.

### 부정 / 의도된 trade-off

- **frontmatter 시그널 손실** — `stripFrontmatter` 가 leading YAML 블록 통째로 제거. tags / aliases 같은 유용한 신호도 같이 사라짐. v0.0.1 단순성 우선 (사용자가 William 본인뿐, Obsidian tag 활용 X). 향후 별도 컨텍스트 블록으로 surface 가능.
- **새 wiki 페이지 surface 없음** — bootstrap 의 `suggestNewPage` proposals 는 wiki 페이지가 아직 존재하지 않아 banner 가 뜰 곳 없음. **dogfood gate 후보 발견 사항**. proposal 0 인 경우엔 토스트로 surface 되지만, 0 이 아닌 경우 사용자가 어디서 review 하는지 명확하지 않음. dogfood 결과에 따라 v0.0.1 안에서 보강 (사이드바 "Pending memory (N)" 또는 자동 apply 등) 또는 v0.1 로 deferred.
- **`runIngestCore` private → export 변경** — bootstrap 진영이 import 해야 하니 export 필요. 향후 lint runner 등이 같은 코어 호출하는 길도 열려있음 (의도된 확장점).

### 미래 영향

- B4 (URL fetch via sidecar) — Node `fetch` + turndown 으로 HTML → MD 변환 후 `chunkText` 그대로 → `bootstrapIngest` 호출. 사이드카 `fetch_url` MCP tool 추가만 신규.
- B5 (Adaptive Interview) — `runChat` 의 `relayTools: ['submit_ingest_result']` 호출 → 결과를 `bootstrapIngest` 와 같은 출구로 enqueue. 인터뷰 turn 들의 압축본을 `chunkText` 로 안 쪼개도 됨 (이미 짧음).
- Lint runner (Block C, deferred) — daily 본문을 입력으로 받는 `bootstrapIngest` 변형 호출 가능. provenance 명시 prompt 만 새로.

## Verification

- `pnpm --filter writer-tauri typecheck` — 통과
- `pnpm --filter writer-tauri test` — 140 통과 (126 + parseImport 14)
- E2E (수동 2026-05-20):
  - `localStorage` `bootstrapCompleted` 리셋 → 새로고침
  - BootstrapDialog 등장 → Import 체크 → Next
  - OS 파일 picker → 1 파일 선택
  - 토스트 등장: "Imported 1 file — No new facts to extract"
  - `ingestStore.pendingProposals` = `[]` (0-proposal 케이스 확인)

## Commits

| phase | commit | 내용 |
|---|---|---|
| B1 | `a2fd5055` | BootstrapDialog shell + `settingsStore.bootstrapCompleted` |
| D.1.1 | `1a649597` | `runIngestCore` 추출 (no behavior change) |
| D.1.2 | `27cbf9dd` | `bootstrapIngest` export + dev console handle |
| D.2.1 | `55f678a8` | `parseImport` utils + 14 단위 테스트 |
| D.2.2 | `2524b277` | `runImport` (파일 picker + bootstrapIngest 루프) |
| D.2.3 | `1f28ed60` | Stage 2 wire + 완료 토스트 (4 분기) |

## References

- 1차 plan 의 Theme 3 설계: `/Users/williamjung/.claude/plans/async-imagining-book.md` (특히 "Theme 3 — 1차 슬라이스 실행 계획" 섹션)
- 사이드카 `submit_ingest_result` tool: `apps/writer-tauri/sidecar/src/server.mjs`
- WikiPageBanner (검토 surface): `apps/writer-tauri/src/layout/WikiPageBanner.tsx` — ADR 2026-05-13 에서 도입
- Karpathy LLM Wiki 원형: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
