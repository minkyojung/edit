# Drift 정책 — Marks

이 문서는 마크의 anchor 와 본문 텍스트가 어긋났을 때 (drift) 시스템이 어떻게 동작해야 하는지의 단일 정책 명세다. 모든 drift 판정은 `apps/writer-tauri/src/domain/marks.ts` 의 `isStaleMark(mark, currentQuote)` 한 함수로 통일된다.

## 정의

**Drift** = 마크가 만들어진 시점의 anchor 텍스트 (`mark.quote`) 와 현재 그 anchor 위치의 텍스트가 다른 상태.

예시:
- AI 가 "Sarah loves dogs" 자리에 제안 마크 생성
- 사용자가 그 텍스트를 "Sarah likes cats" 로 직접 편집
- 마크의 `quote` 는 여전히 "Sarah loves dogs" 인데, anchor 위치의 현재 텍스트는 "Sarah likes cats"
- → drift 발생, 마크는 stale 상태로 전환되어야 함

## 정책

### 1. Drift 자동 보정 안 함

proof-sdk 가 시도하던 다음 인프라는 **모두 폐기**:
- Fuzzy text matching (비슷한 텍스트 다른 곳에서 찾아 옮김)
- Projection repair (Y.Doc 과 markdown 의 양방향 자동 재정렬)
- Pathological repeat quarantine (자동 보정 무한 루프 차단)
- Drift detector (서버 사이드 텍스트 추적)

**이유**:
- 우리 도메인 (단일 유저, 산문, 백그라운드 ingest) 에서 자동 보정의 정확도가 낮음
- 잘못 옮긴 마크는 안 옮긴 마크보다 나쁨 (사용자가 발견 못 함)
- 인프라 복잡도가 시스템 복잡성의 70~80%

### 2. Accept 시점 — quote 일치 검증

`markStore.accept(args)` 가 호출될 때:

1. PM doc 의 anchor 위치에서 현재 텍스트 (`currentQuote`) 추출
2. `isStaleMark(mark, currentQuote)` 호출
3. 결과:
   - `false` (일치) → 정상 적용. status='accepted'.
   - `true` (불일치) → status='stale' 로 전환. 사용자에게 알림. 본문은 **건드리지 않음**.

```ts
// markStore.accept 의 핵심 로직 (Phase 1 에서 구현)
const currentQuote = view.state.doc.textBetween(from, to)
if (isStaleMark(mark, currentQuote)) {
  marksMap.set(markId, { ...mark, status: 'stale' })
  notify.markStale()
  return false
}
// ... 정상 accept 로직
```

### 3. 표시 시점 — list / hover 의 stale 자동 마킹

UI 가 마크를 렌더할 때 (hover popover, EditorFooter 카운트 등) 모든 pending 마크에 대해 `isStaleMark` 호출:

- 불일치 발견 → 그 자리에서 status='stale' 로 업데이트 + UI 에 stale 표지 (회색 + "본문이 바뀜" 라벨)
- 일치 → 정상 표시

이렇게 하면 사용자가 accept 버튼 누르기 전에도 "이 제안은 이미 적용 불가" 가 시각적으로 보임.

### 4. Stale 마크의 정리

| 상황 | 처리 |
|---|---|
| 사용자가 stale 마크의 X 버튼 클릭 | 즉시 `reject` (마크 제거) |
| 7일 경과 stale 마크 | Phase 6 의 lint job 이 자동 제거 |
| 사용자가 본문을 원래대로 복구 | `isStaleMark` 가 다시 false → status='pending' 으로 자동 복귀 |

마지막 케이스 (자동 복귀) 는 Phase 1 에서 구현 — list/hover 시 isStaleMark 가 호출될 때 stale → pending 으로 양방향 전환.

### 5. 빈 quote 처리

`mark.quote` 가 빈 문자열인 경우:
- 데이터 손상 (validation 단계에서 잡혀야 함)
- `isStaleMark` 는 `false` 반환 (drift 가 아닌, 별도 문제로 분류)
- `isValidMark` 가 이 경우를 reject 해야 함 (현재 `marks.ts` 의 구현이 이미 그러함)

## 왜 이 정책

### 직정 비교 (proof-sdk 의 자동 보정 vs 우리의 stale 표시)

| 영역 | proof-sdk | 우리 |
|---|---|---|
| 마크가 다른 위치로 자동 이동 | O | X |
| 마크가 깨졌을 때의 동작 | 보정 시도, 실패 시 silent | 명시적 stale 표시 |
| 사용자가 인지 가능한가 | 일부 케이스에서 못 함 | 항상 시각화 |
| 인프라 복잡도 | 높음 (서버 사이드 + drift detector + quarantine) | 낮음 (한 비교 함수) |
| 잘못된 자동 이동의 위험 | 있음 | 없음 |

### 단점 수용

이 정책의 단점:
- 마크가 "정말로" 옮길 수 있는 케이스 (사용자가 텍스트 살짝 다듬은 경우) 에서도 stale 처리됨 → 사용자가 마크를 다시 만들거나 본문 복구해야 함
- 백그라운드 ingest 가 만든 제안이 사용자 편집과 자주 충돌 → stale 증가

이 단점은 **트레이드오프로 수용**. 이유:
- 자동 보정의 정확도는 검증 안 됨
- stale 마크의 사용자 부담은 dismiss 한 번
- 보정 실패의 사용자 부담은 "잘못된 곳에 적용됨" 또는 "어디 갔는지 모름" — 훨씬 큼

## 코드화

### 단일 진입점

```ts
// apps/writer-tauri/src/domain/marks.ts
export function isStaleMark(mark: Mark, currentQuote: string): boolean {
  if (mark.quote.length === 0) return false
  return mark.quote !== currentQuote
}
```

이게 정책의 코드. 변경하려면 이 함수 + 이 문서를 같이 수정.

### Phase 별 적용 시점

| Phase | 적용 |
|---|---|
| 0 | `isStaleMark` 함수 작성 (✓ 완료) |
| 1 | markStore.accept / list 에서 호출 |
| 2 | UI (hover popover, banner) 가 stale 마크 시각화 |
| 6 | lint job 이 7일 경과 stale 마크 자동 제거 |

## 변경 이력

| 날짜 | 변경 | 이유 |
|---|---|---|
| 2026-05-15 | 초안 작성 | Phase 0 산출물 |
