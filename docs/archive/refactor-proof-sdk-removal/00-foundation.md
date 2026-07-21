# Phase 0 — 기반 정의

**기간**: 1주
**목적**: 다음 phase 들의 기준이 되는 명세 3개를 만든다. 코드 변경 0, 문서 + 타입 정의만.

## 산출물

| 산출물 | 위치 | 형태 |
|---|---|---|
| 마크 도메인 타입 정의 | `apps/writer-tauri/src/domain/marks.ts` (신규) | TS 타입 + 검증기 |
| markStore 인터페이스 | `apps/writer-tauri/src/domain/markStore.ts` (신규) | 인터페이스 + stub |
| Drift 정책 문서 | `docs/refactor-proof-sdk-removal/policies/marks-drift.md` (신규) | 마크다운 |

## 작업 1 — 마크 도메인 타입 정의

### 왜 새 위치
현재 `StoredMark` 는 `apps/writer-tauri/src/hooks/useCollabDoc.ts:13~53` 에 있음. hook 안에 도메인 모델이 사는 구조는 어색하고, proof-sdk 제거 후엔 이 hook 자체가 의미가 약해짐. `src/domain/` 으로 옮겨 도메인 레이어 분리.

### 새 모델 결정 사항

#### (a) 마크 종류를 3개로 좁힘
proof-sdk 의 7개 (`authored / approved / flagged / comment / insert / delete / replace / provenance`) 중 우리가 실제로 쓰는 것만 남김:

```ts
type MarkKind =
  | 'suggestion'  // AI 제안 (insert/delete/replace 는 sub-kind 로)
  | 'comment'     // 사용자/AI 코멘트
  | 'authored'    // 출처 breadcrumb (accept 후 영구 흔적)
```

폐기: `approved`, `flagged`, `provenance` (현재 dead). `insert/delete/replace` 는 `Mark.kind` 가 아닌 `Mark.suggestionType` 으로 한 단계 내림.

#### (b) `Y.Map('marks')` + `Y.Map('authoredMeta')` 통합
현재 두 곳에 분산된 메타를 한 `Mark` 객체로:

```ts
interface Mark {
  // 식별 / 종류
  id: string                              // 필수 — proof-sdk 와 달리 optional 아님
  kind: MarkKind
  suggestionType?: 'insert' | 'delete' | 'replace'  // kind === 'suggestion' 일 때만

  // 앵커 (이 마크가 어디에 붙어 있나)
  quote: string                           // 마크 생성 시점의 텍스트 (drift 감지에 사용)
  startRel: string                        // Y.RelativePosition (base64)
  endRel: string

  // 내용 (kind 별 의미 다름)
  content?: string                        // suggestion 의 새 텍스트
  text?: string                           // comment 의 본문

  // 메타
  status: 'pending' | 'accepted' | 'rejected' | 'stale'
  by: string                              // 작성자 (예: 'ai:haiku-4.5', 'human:unknown')
  createdAt: string                       // ISO timestamp
  acceptedAt?: string

  // 출처 (현재 authoredMeta 에 있던 것)
  sourceSlug?: string                     // 이 제안이 어떤 doc 에서 유래했나
  sourceLabel?: string
  sourceQuote?: string
  model?: string                          // 모델 이름 ('claude-haiku-4-5-20251001' 등)
}
```

#### (c) 검증기
`src/domain/marks.ts` 에서 export:

```ts
export function isValidMark(m: unknown): m is Mark { ... }
export function isStaleMark(mark: Mark, currentQuote: string): boolean { ... }
```

`isStaleMark`: mark 의 anchor 위치에서 실제 텍스트를 읽어왔을 때 `mark.quote` 와 다르면 true. 이 함수가 drift 정책의 코드화.

### 마이그레이션 고려
- 기존 `Y.Map('marks')` + `Y.Map('authoredMeta')` 의 데이터 형태 → 새 `Mark` 로 변환하는 `migrateLegacyMark()` 함수 포함
- 유저 0 이므로 dev DB 마이그레이션은 무시 가능. 새 시작.

### 검증
- [ ] `src/domain/marks.ts` 작성 + 검증기 단위 테스트
- [ ] 7개 → 3개로 좁힌 결정을 README 에서 호출자별로 확인:
  - `proofSuggestion` 사용처 → 모두 `kind: 'suggestion'` 으로 매핑 가능 확인
  - `proofComment` 사용처 → `kind: 'comment'`
  - `proofAuthored` (accept 후 stamp) → `kind: 'authored'`
  - 다른 마크 종류 사용처 → 0건 확인 (grep)

## 작업 2 — markStore 인터페이스 정의

### 위치
`apps/writer-tauri/src/domain/markStore.ts` (신규)

### 인터페이스

```ts
export interface MarkStore {
  /** 새 마크 생성. 위치는 quote 와 EditorView 의 현재 selection / textIndex 로 결정. */
  add(args: {
    slug: string
    kind: MarkKind
    suggestionType?: 'insert' | 'delete' | 'replace'
    quote: string
    content?: string
    text?: string
    by: string
    sourceSlug?: string
    sourceLabel?: string
    model?: string
  }): Promise<{ ok: true; markId: string } | { ok: false; reason: string }>

  /** 마크 수락. suggestion → quote 자리 content 로 교체 + status='accepted' + authored stamp.
   *  comment → no-op + status='accepted' (resolve 와 동의어). */
  accept(args: { slug: string; markId: string; by: string }): Promise<boolean>

  /** 마크 거절. PM 마크 + Y.Map 엔트리 모두 제거. */
  reject(args: { slug: string; markId: string; by: string }): Promise<boolean>

  /** 마크 조회. */
  get(slug: string, markId: string): Mark | null

  /** 슬러그의 모든 마크 (status 필터링 옵션). */
  list(slug: string, opts?: { status?: Mark['status'] }): Mark[]

  /** 슬러그의 마크 변화 구독 (UI 가 마크 카운트 등에 사용). */
  subscribe(slug: string, listener: (marks: Mark[]) => void): () => void
}
```

### 인터페이스 결정 이유
- `add` 가 quote 를 받지만 정확한 위치 (range) 는 받지 않음 — 구현이 EditorView 에서 quote 를 찾아 anchor 만듦. proof-sdk 의 `suggestion.add` 와 같은 패턴.
- `accept` / `reject` 는 boolean 반환 (실패 시 false). 사용자에게 toast 띄울지 결정하는 건 호출자.
- `list` 는 사이드바 카운트 / lint 가 사용.
- `subscribe` 는 호출자가 React effect 안에서 사용.

### 구현은 Phase 1 에서. 이 phase 에선 인터페이스 + stub 만.

### 검증
- [ ] 인터페이스 컴파일 통과
- [ ] Phase 1~2 의 모든 호출 패턴이 이 5개 메서드로 표현 가능한지 검토:
  - `applyProposal` → `add`
  - `markActions.acceptMark` → `accept`
  - `markActions.rejectMark` → `reject`
  - `markActions.cleanupMark` → `reject` (suggestion) 또는 `accept` (comment.resolve 와 동의어)
  - `MarkToolbar` 의 코멘트/제안 생성 → `add`
  - `WikiPageBanner` 의 accept → `accept`

## 작업 3 — Drift 정책 문서

### 위치
`docs/refactor-proof-sdk-removal/policies/marks-drift.md` (신규)

### 내용 (요약 — 이 파일에 작성할 본문 골격)

```markdown
# Drift 정책

## 정의
Drift = 마크가 만들어진 시점의 anchor 텍스트 (`mark.quote`) 와
현재 그 anchor 위치의 텍스트가 다른 상태.

## 정책

1. Drift 자동 보정 안 함. proof-sdk 가 시도하던 fuzzy match / projection
   repair / pathological repeat quarantine 같은 인프라 전부 폐기.

2. Accept 시점에 quote 일치 확인:
   - 일치 → 정상 적용
   - 불일치 → 자동으로 mark.status = 'stale' 로 전환, 사용자에게 알림
     ("이 제안은 더 이상 적용할 수 없습니다 — 본문이 바뀌었습니다")

3. List/Hover 시점에 quote 일치 확인:
   - 일치 → 정상 표시
   - 불일치 → 'stale' 표지 (회색 + "본문이 바뀜" 라벨)

4. Stale 마크 정리:
   - 사용자가 'stale' 마크를 명시적으로 dismiss 가능
   - 7일 경과 stale 마크는 자동 제거 (lint job 이 청소)

## 왜 이 정책

- 우리 도메인 (단일 유저, 산문, 백그라운드 ingest) 에서 drift 자동
  보정의 정확도는 낮음. 잘못 옮긴 마크는 안 옮긴 마크보다 나쁨
  (사용자가 발견 못 함).
- "이 제안은 stale 입니다" 라는 UX 가 정직함.
- 인프라 복잡도가 70~80% 줄어듦.

## 코드화

isStaleMark(mark, currentQuote) — domain/marks.ts

이 함수가 정책의 단일 진입점. 모든 drift 판정은 이 함수를 통해야 함.
```

### 검증
- [ ] 문서 머지
- [ ] 정책에 대한 사용자 승인 (Phase 1 시작 전)

## 완료 기준

- [ ] 3개 산출물 머지됨
- [ ] 컴파일 통과 (새 타입이 기존 코드와 충돌 안 함 — 새 타입은 아직 사용되지 않음)
- [ ] 회귀 0 (코드 동작 변화 없음)

## 다음 단계
Phase 1 — markStore 의 in-memory 구현. 이 인터페이스 위에서 실제 동작.

## 위험

| 위험 | 완충 |
|---|---|
| 인터페이스가 부족해서 Phase 2 호출자가 표현 불가 | Phase 0 끝나기 전 모든 기존 호출 패턴을 종이에서 매핑 시뮬레이션. 부족하면 인터페이스 보강 |
| 마크 종류 3개 좁힘이 실제 사용처와 안 맞음 | grep 으로 모든 `MarkKind`, `proofMark*` 사용처 1:1 확인 |
| Drift 정책의 7일 자동 제거가 너무 짧음/길음 | 30일 / 7일 / 1일 옵션 보류. Phase 6 lint job 만들 때 사용자와 결정 |
