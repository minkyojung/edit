# ADR: ingest 검토 UX 재구조화 — 절반-적용 상태와 갈림길

작성: 2026-05-10
상태: **In progress / Decision pending**

이전 ADR: `2026-05-08-wiki-ingest-system.md` (마크 시스템 위에 ingest 를 얹은 최초 설계)

---

## Context

기존 ingest 시스템은 proof-sdk 의 마크 인프라를 그대로 재사용해서 `proofSuggestion(kind='insert')` 마크를 anchor word 에 stamp 하고, ghost widget 으로 미리보기를 띄우는 형태였다 (이전 ADR 참조).

이 모델에서 두 개의 사용자-가시 버그가 동시에 드러남:

1. **Ghost preview 가 blockquote 안에 끼어 들어감.** anchor 단어가 blockquote 내부 paragraph 에 있으면 widget DOM 이 그 wrapper 안쪽에 inline 으로 박힘. 반면 accept 후 실제 콘텐츠는 top-level sibling 으로 삽입 → pre-accept 위치 ≠ post-accept 위치.
2. **Cmd+Z 후 마크 복원 안 됨.** Accept 가 PM transaction (텍스트 수정) + Y.Map mutation (StoredMark 변경) 두 단위로 일어나는데, PM undo 는 PM 만 되돌리고 Y.Map 은 안 따라옴. 결과: 텍스트는 사라졌지만 StoredMark 는 'provenance' 로 남아 마크가 다시 안 떠있음.

두 버그의 공통 뿌리는 **세 개 진실 소스가 따로 움직임**:

- PM 인라인 마크 (위치 + 시각)
- Y.Map<StoredMark> (메타데이터)
- Decoration.widget ghost (미리보기 콘텐츠)

이 세 레이어가 서로 동기화되어야 화면이 정합한데, undo / nesting / sync 어느 한 축이라도 어긋나면 즉시 사용자에게 보이는 결함이 됨.

---

## 시도한 구조적 단순화 (절반 진행)

목표: **세 레이어를 하나로** — 콘텐츠를 PM 트리에 실제 노드로 박고, 그 범위에 "pending" 마크만 입힘. PM 가 단일 권위. Accept = 마크만 떼기, Reject = 범위 통째로 삭제. 모두 PM transaction 한 단위라 undo 자연스러움.

설계한 단계:

| Step | 내용 | 상태 |
|---|---|---|
| 1 | 정책 결정: 새 콘텐츠는 페이지 맨 위 (`pos 0`) 에 삽입 | 합의됨, 코드 0줄 |
| 2 | `proofSuggestion(kind='insert')` 의미 재정의 (anchor word → 콘텐츠 범위 자체) | Step 3 코드에 흡수 예정 |
| 3 | `applyOneAsMark` 재작성 — `applyProposal` 우회, 페이지 맨 위에 PM 블록 직접 삽입 | **유실** (작업했으나 커밋 안 됨) |
| 4 | `markDecoPlugin` 의 ghost widget 제거 (insert kind 한정) | ✅ 머지됨 (`65f33815`) |
| 5 | 블록 단위 시각화 (점선 보더 + 옅은 배경, node decoration) | 미진행 |
| 6 | `acceptMark(insert)` 단순화 — 마크만 제거 | 미진행 |
| 7 | `rejectMark(insert)` — 범위 삭제 | 미진행 |
| 8 | Undo 통합 검증 | 미진행 |

함께 머지된 보조 작업:
- `proofProvenance` 스키마 추가 (수락 후 영구 breadcrumb)
- `acceptMark` 가 마크를 삭제하는 대신 provenance 로 변환
- `topLevelSiblingAfter` 헬퍼 (pre/post 위치 비대칭 봉합)

---

## 지금 코드베이스 상태 — "절반-적용" 회귀

Step 4 (ghost 제거) 가 머지되었으나 Step 3 (콘텐츠를 노드로 삽입) 이 빠져있어, 사용자가 보는 화면이 **두 모델 어느 쪽도 아닌 빈 상태**:

- apply 단계: 옛 모델 그대로 (`mark.attrs.content` 에 콘텐츠 저장, anchor word 위에 mark stamp)
- 렌더 단계: ghost widget 사라짐 → 미리보기 없음
- 결과: 사용자 눈엔 **단어 하나에 노란 밑줄만**, 제안 내용은 어디에도 안 보임. Accept 누르면 그제서야 콘텐츠 출현.

→ Step 4 가 머지되기 전 (옛 모델 완전판) 보다도 UX 가 후퇴한 상태.

---

## Path 별 분석

### A. Step 3 재구현 (앞으로)
- `applyIngest.ts` 의 `applyOneAsMark` 다시 작성: 마크다운 파싱 → PM `pos 0` 에 블록 삽입 → 그 범위에 `proofSuggestion(insert)` 마크
- `markActions.ts` 의 accept/reject 도 새 의미에 맞춰 단순화 (Step 6, 7)
- 우리가 합의했던 single-source-of-truth 구조 완성
- **장점**: 구조적 정직성. 두 버그의 공통 뿌리 자체를 제거.
- **단점**: 작업량. 마크 의미가 변경되어 다른 마크 소비자 (popover, deco) 도 영향 검토 필요.

### B. Step 4 revert (뒤로)
- `65f33815` 되돌리기 → ghost widget 부활
- Phase 2 (provenance) + topLevelSibling (위치 봉합) 만 남는 보수 상태
- 옛 ghost 의 blockquote 문제는 topLevelSibling 으로 부분 완화됨 (단어 anchor → 그 anchor 의 top-level sibling 에 ghost 표시)
- **장점**: 즉시 동작. 회귀 해소.
- **단점**: 우리가 진단한 구조적 문제 (3 진실 소스, undo 깨짐) 그대로 남음. ghost 는 여전히 우회.

### C. 마크 시스템 분리 (다른 방향)
- 마크는 chat AI 인라인 수정에만 — 본래 용도
- Ingest 검토는 **별도 review 카드 모달** 로
  - 사이드바 카드 → 클릭 시 모달 → 카드별 Accept/Reject
  - Accept = 일반 텍스트 삽입 (마크 안 씀)
- **장점**: 두 시스템이 다른 일을 한다는 사실을 코드에 정직하게 반영. 마크 시스템 회귀 위험 0. 카드 = 이메일 inbox 같은 자연스러운 비유.
- **단점**: 검토가 페이지 컨텍스트에서 분리됨 (이전 ADR 의 "in-context review" 이점 일부 손실). 새 모달 컴포넌트 필요.

---

## Decision

**미정.** 셋 중 하나로 마무리해야 절반-적용 회귀가 사라짐.

엔지니어 관점에서 A 가 정공법 (구조적 뿌리 제거), C 가 가장 정직한 단순함 (서로 다른 일은 서로 다른 도구), B 는 단기 회귀 회피.

다음 의사결정 자리에서 확정 필요.

---

## Files (현 상태 기준)

남아있는 작업의 손이 닿을 곳:

- `src/agent/applyIngest.ts` — Step 3 재작성 대상 (A 선택 시) 또는 그대로 (B/C 선택 시)
- `src/editor/markDecoPlugin.ts` — Step 4 결과물; B 선택 시 revert 대상
- `src/editor/markActions.ts` — Phase 2 (provenance 변환) 머지됨; A 선택 시 추가 단순화
- `src/editor/topLevelSibling.ts` — 신규 헬퍼; 어느 path 가도 유용 (제거 불필요)
- `src/editor/proofMarkSchemas.ts` — `proofProvenance` 스키마 머지됨; 어느 path 가도 유지
- `src/hooks/useCollabDoc.ts` — `StoredMark` 의 provenance 필드 머지됨; 유지

신규 (C 선택 시):
- `src/layout/IngestReviewModal.tsx` — 카드 단위 검토 모달 (가칭)
