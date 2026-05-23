# ADR: Profile pipeline rebuild — Karpathy-aligned Sources + wiki:profile

작성: 2026-05-20
상태: **Accepted (Phase 1~4 land, dogfood gate 입장)**
대체: `2026-05-20-bootstrap-import-pipeline.md` (같은 날 morning land, 같은 날 afternoon supersede)
관련: `2026-05-08-wiki-ingest-system.md`, `2026-05-13-wiki-ingest-banner-inbox.md`

---

## Context

Morning 의 bootstrap import 파이프라인 (`runImport` + `bootstrapIngest` + `extractProfile`) 은 land 직후 검토에서 두 가지 구조적 문제가 부각됐다:

1. **흐름이 모놀리식.** `BootstrapDialog → fetchUrl → extractProfile → seedDocBody` 단방향 직렬. 중간에 사용자에게 보여줄 훅이 없고 (점진적 공개 불가능), `extractProfile` 이 RSS / Substack 호스트별 분기를 hardcode 하고 있어 어댑터 추가 비용이 큼. 최근 6 개 커밋이 모두 RSS 파싱 brittleness 패치였던 것이 토대 약함의 신호.
2. **Karpathy LLM Wiki 정신에서 멀어짐.** `ProfileFields` 라는 구조화 JSON 을 강제로 추출하고 (`submit_profile` tool_choice), 그걸 markdown 으로 렌더링해서 단발성으로 vault 에 박는 방식. raw 글들은 휘발성 (메모리에만), 결과는 `wiki:profile` 1 덩어리 markdown — Karpathy 가 일관되게 쓰는 "raw 노트는 영구 보존, wiki 는 그 위의 view" 패턴과 어긋남.

세 가지 대안:

1. **점진적 리팩토링** — 어댑터 추상화만 분리, ProfileFields/extractProfile/Stage2 dialog 유지.
2. **부분 재작성** — `extractProfile` 만 결정 zone 별 LLM 호출 3 개로 쪼개고 ProfileFields JSON 폐기.
3. **전체 재작성** — Karpathy 정신으로 새로 그림: Source 어댑터 → 원본 글을 vault 에 markdown 으로 저장 → LLM 섹션 호출 3 개 → wiki:profile 의 zone 별 markdown 으로 조립.

비용 — 사용자가 기존 사용자 0 명임을 확인 (`bootstrapCompleted` 만 flip 된 vault 들), 호환 어댑터 불필요. 옛 코드 전부 폐기 가능.

## Decision

대안 3 채택. 같은 브랜치에서 한 번에 갈아엎고 (옆에 짓기 + 한 번에 스위치 X — 사용자 0 이므로 더 단순), 5 step 으로 끊어서 land.

### 새 구조 — 3 layer

```
Layer 1: Sources (raw, 영구 저장)
  vault/sources/
  ├── _index.json                    ← import 기록 (URL, fetchedAt, files[])
  └── <adapter-namespace>/
      ├── 2026-04-15--<slug>.md      ← frontmatter + 본문
      └── ...

Layer 2: 분석 단계 (메모리, 휘발)
  pipeline 안에서 LLM 3 회 호출 (Voice / Themes / About)
  Haiku 4.5 + prompt caching + 429 backoff retry

Layer 3: Wiki Profile Page (derived, single source of truth)
  vault/wiki/Profile.md
  ## Voice         ← profile pipeline 영역 (replaceZone 으로 부분 갱신)
  ## Themes        ← profile pipeline 영역
  ## About         ← profile pipeline 영역
  ## Sources       ← profile pipeline 영역 (글 링크 목록)
  ## Background    ← ingest LLM 영역 (DEFAULT_CONVENTIONS 가 가르침)
  ## Notes         ← 사용자 영역
```

### Zone 분리 메커니즘

H2 헤딩 자체가 zone 경계. HTML 주석 마커는 초기 시도했으나 Milkdown 파서가 노드로 인식 안 해서 markdown roundtrip 시 사라짐 — 헤딩 기반 슬라이스로 전환. `replaceZone(markdown, kind, newContent)` 가 헤딩 라인부터 다음 H2 직전까지를 새 내용으로 교체.

이 contract 가 **세 writer (profile pipeline / ingest LLM / 사용자)** 가 같은 페이지에서 안 부딪히게 만드는 핵심.

### Conventions 위치

`PROFILE_SECTIONS` (섹션별 LLM 지침) 는 TS 코드 const 로 둠. 트레이드오프:
- **장점**: 3 번의 섹션 호출이 같은 schema 를 봐서 결과가 일관됨. 사용자가 분석 중 페이지 편집해도 결과 깨짐 없음.
- **단점**: 사용자가 분석 규칙을 못 바꿈. 카파시 정신에선 wiki 페이지로 두는 게 더 충실 (사용자 베이스 늘면 그때 전환).

`DEFAULT_CONVENTIONS` (ingest LLM 이 wiki:profile zone 룰 따르도록) 는 system page (wiki) 라 사용자 편집 가능. 이쪽은 카파시 정공법 그대로.

### Provenance (model / derivedAt / sourceFiles)

Phase 2 에서 `vault/derivations/<kind>.json` 으로 별도 저장했다가 Phase 5 (refactor) 에서 폐기. 이유: `Profile.md` 가 이미 derivation 의 내용이라 JSON 은 단순 복제. 메타데이터 (어떤 모델로 언제) 가 필요해지면 `Profile.md` frontmatter 로 묻거나 사이드카 만들면 됨 — 지금은 안 만듦.

### Tradeoff: OAuth-token 예산 공유

`anthropic_messages_create` Tauri command 가 Claude Code OAuth 토큰을 그대로 끌어다 씀 (`sk-ant-oat-*`). chat / ingest / profile 이 모두 같은 풀에서 토큰 차감. 첫 dogfood 시 8 편 × 4000 자 × 3 호출 → 429 rate_limit. 다음 완화:

- 글 수 cap 20 → 8, per-post 자수 4000 → 2000
- prompt caching: system + posts 를 고정 prefix 로, 섹션별 instruction 만 marker 뒤로 → 호출 2/3 에서 cache hit
- 429 시 1s / 2s / 4s exponential backoff 4 회
- Sonnet 4.6 → Haiku 4.5 (~3× 싸짐)

여전히 OAuth 토큰 자체가 hard cap. v0.0.1 에선 감수. v0.1 에서 API key 입력 옵션 검토.

## Step Order (실제 land 순서)

```
Step 1   기존 코드 삭제 (a9017329)                 -1894줄
Step 2   profile/conventions.ts (fabaecce)         +42줄
Step 3   profile/adapters/* (7581e137)             +332줄  RSS/Sitemap/Readability + router
Step 4   profile/pipeline.ts (02a051a9)            +171줄  3 LLM 콜 + assemble + seedDocBody
Step 5   profile/ui/OnboardingDialog.tsx (f53af8a0) +358줄  modal + BootGate trigger
[bug fixes — Haiku swap, prompt caching, retry, byte-aware filename, heading markers]
Phase 1  sources.ts (5e5c8dc8)                     +311줄  vault/sources/ 영구 저장
Phase 2  derivations.ts (baf1c4ce, later REMOVED)
Phase 3  markers.ts + replaceDocBody (d090ac26 + 995b3054)  zone 분리 + Y.Doc 교체
Phase 4  conventions zone 룰 (7a40ee69)            +10줄   ingest 가 Background 영역으로 가도록
Phase 5  derivations.ts 삭제 (dedfa16f)            -159줄  Profile.md 가 single source of truth
```

## Consequences

### 긍정

- **점진적 disclosure 자연스러움.** Onboarding dialog 가 fetched count → voice → themes → about 순으로 카드 채움. Pipeline 의 `onProgress` callback 이 dialog 와 디커플 — pipeline 자체는 UI 모름.
- **재실행 비용 0 (fetch 측면).** Sources 가 vault 에 영구. 재생성 시 디스크 hit. LLM 만 다시 호출.
- **부분 갱신 가능.** `runSection(kind)` 가 한 zone 만 갱신. 다른 zone + 사용자 편집 보존.
- **Zone 계약이 ingest 와도 통함.** ingest LLM 이 `system:conventions` 의 zone 룰을 읽고 wiki:profile 의 `## Background` 에만 append (예정 — 실제 검증은 dogfood 에서).
- **Karpathy 정신 ~90%.** Sources/Profile.md 가 모두 markdown 파일. derivations JSON 폐기 후 single source of truth.
- **코드 라인 순 감소.** 옛 코드 -1894, 새 코드 ~+900 = 순감소 ~1000 줄.

### 부정 / 의도된 trade-off

- **PROFILE_SECTIONS 가 TS 코드.** 사용자가 분석 형식 못 바꿈. 일관성 vs 편집성 트레이드오프; v0.0.1 일관성 우선.
- **OAuth 토큰 예산 공유.** 모든 LLM 기능이 같은 풀. 무거운 분석이 chat/ingest 의 hard cap 을 잡아먹음. API-key 옵션은 deferred.
- **Source 추가 시 동작 미검증.** 두 번째 URL 입력은 코드 경로는 있지만 실제 시도 안 함. dogfood 첫 시도에서 부각 시 fix.
- **Materialisation 의 Background-aware splice 미구현.** ingest LLM 이 wiki:profile 에 append 할 때 페이지 끝으로 들어감 → `## Notes` 영역 침범. 사용자가 자기 데일리에 자기 얘기 본격 쓰기 시작할 때 까지 deferred.

### 미래 영향

- **Source 어댑터 확장점.** 새 어댑터는 `Document[]` 반환만 맞추면 라우터에 등록만 하면 됨. Twitter / GitHub / 일반 sitemap-only 사이트 등.
- **Token usage 가시화.** Anthropic response 의 `usage` 필드 파싱해서 콘솔/UI 에 노출 — 디버깅 + 사용자 가시성. 30 분 작업, dogfood 후 결정.
- **친구 프로필 / 책 / 프로젝트 페이지 동일 패턴.** 같은 3-layer (sources / 분석 / wiki page with zones) 가 wiki:profile 외의 페이지 종류에도 적용 가능. wiki:profile 은 이 패턴의 첫 인스턴스.

## Verification

- `pnpm --filter writer-tauri typecheck` — 통과
- `pnpm --filter writer-tauri test` — 126 통과 (옛 parseImport 14 테스트는 코드와 함께 삭제됨)
- E2E (수동 2026-05-20):
  - localStorage `bootstrapCompleted` 리셋 → 새로고침 → OnboardingDialog 등장
  - URL: `https://williamjung0130.substack.com/` 입력 → Analyze
  - 카드 순서: ✓ Found 8 posts via rss → ✓ Voice → ✓ Themes → ✓ About → done
  - Profile.md 생성, 헤딩 6 개 (Voice/Themes/About/Sources/Background/Notes), Background/Notes 는 빈 헤딩
  - Source 글 8 편 모두 `vault/sources/williamjung0130-substack-com/` 에 저장 (byte-truncate 적용)
- 콘솔 재실행 (Profile.md replace): `replaceDocBody` 가 Y.Doc fragment clear + apply 로 페이지 교체 — 동작 확인

## Commits

| phase | commit | 내용 |
|---|---|---|
| Step 1 | `a9017329` | 옛 onboarding/profile 코드 전부 삭제 |
| Step 2 | `fabaecce` | profile/conventions.ts — PROFILE_SECTIONS const |
| Step 3 | `7581e137` | profile/adapters/* — RSS/Sitemap/Readability + router |
| Step 4 | `02a051a9` | profile/pipeline.ts — fetch → 3 LLM 호출 → assemble |
| Step 5 | `f53af8a0` | profile/ui/OnboardingDialog.tsx + BootGate trigger |
| fix | `df622b70` | prompt caching + 429 backoff + 입력 사이즈 축소 |
| fix | `32ae9ecf` | Sonnet → Haiku |
| Phase 1 | `5e5c8dc8` | sources.ts — vault/sources/ 영구 저장 |
| Phase 2 | `baf1c4ce` | derivations.ts (later removed) |
| Phase 3 | `d090ac26` | markers + replaceDocBody (HTML comment, later fixed) |
| Phase 3 fix | `995b3054` | 헤딩 기반 zone + byte-aware filename |
| Phase 4 | `7a40ee69` | DEFAULT_CONVENTIONS 에 wiki:profile zone 룰 |
| Phase 5 | `dedfa16f` | derivations JSON 폐기 — Profile.md = single source of truth |

## References

- 카파시 LLM Wiki 원형: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- 옛 ADR (superseded): `2026-05-20-bootstrap-import-pipeline.md`
- 어댑터 패턴 영감: Readwise sources adapter shape, RSS feed discovery (`<link rel="alternate">`)
- DEFAULT_CONVENTIONS 위치: `apps/writer-tauri/src/state/wikiService.ts`
- profile pipeline entry: `apps/writer-tauri/src/profile/pipeline.ts`
