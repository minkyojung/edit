# Proof-SDK 제거 + Wiki LLM 재구성 로드맵

## 목적

`proof-sdk` 의존을 완전히 제거하고, mark 시스템을 자체 구현으로 갈아끼우며, 동시에 Wiki LLM (Karpathy 패턴) 구현을 정리/확장한다.

## 왜 이 작업이 필요한가

### 문제 1 — proof-sdk 와 우리 client 의 구조적 불일치

지난 3주 동안 mark mutation 을 `proofClient.ops()` 단일 경로로 정렬하는 Track 1 작업을 진행. 그 과정에서 다음이 드러남:

- 데이터를 모두 비운 상태 (0 marks, 0 markdown, 0 y_updates) 에서도 proof-server 가 `TypeError: undefined is not an object (evaluating 'node.children.some')` 로 실패. 데이터 문제가 아니라 **Y.Doc 구조 자체** 가 server 가 기대하는 형태와 다름.
- 우리는 `proofEditor` 가 아닌 자체 Milkdown 조립 (24개 커스텀 플러그인 — wikilink, daily, slash menu 등) 을 사용. proof-sdk 의 server 는 자기네 client 와만 호환되도록 설계됨.
- 우리에게 필요한 것은 marks lifecycle + 단순 영속성. proof-sdk 가 만든 drift detector, projection repair, pathological repeat quarantine 같은 인프라는 우리 도메인에서는 부담.

### 문제 2 — Wiki LLM 구현이 분산되고 길어짐

- `apps/writer-tauri/src/agent/ingest.ts` 709줄: 프롬프트 조립 + wiki 읽기 + 모델 호출 + 파싱 + sanitize 한 파일
- `apps/writer-tauri/src/agent/chat.ts` 666줄: 스트림 멀티플렉서 + tool 상관 + proposal listener 한 파일
- `apps/writer-tauri/src/state/wikiService.ts` 388줄: `ensureSystemPage` 3번 복붙
- `apps/writer-tauri/src/state/docsStore.ts` 1374줄: mark 책임 일부 섞임
- mark 데이터 모델이 `apps/writer-tauri/src/hooks/useCollabDoc.ts:13~53` 에 정의 — 도메인 모델이 hook 안에 사는 구조적 어색함
- `Y.Map('marks')` 와 `Y.Map('authoredMeta')` 두 곳에 같은 mark 의 메타가 흩어짐

### 결정

- proof-sdk 의존 0 으로. 자체 구현으로 교체. (옵션 D)
- 자율성 70 비전 유지: 백그라운드 ingest → 위키 메모리 → AI 가 본문에 inline mark 로 개입.
- Drift 정책: **자동 보정 안 함, 깨지면 stale 표시**. proof-sdk 식 자동 추적을 시도하지 않음으로써 복잡성 80% 제거.

## Phase 구성

| Phase | 주제 | 기간 | 파일 |
|---|---|---|---|
| 0 | 기반 정의 (마크 모델 + interface + drift 정책) | 1주 | [00-foundation.md](./00-foundation.md) |
| 1 | 새 markStore in-memory 구현 | 1.5주 | [01-markstore.md](./01-markstore.md) |
| 2 | 호출자 갈아끼우기 (markActions, applyProposal, MarkToolbar, WikiPageBanner) | 1주 | [02-migration.md](./02-migration.md) |
| 3 | proof-sdk / proof-server 제거 | 4일 | [03-removal.md](./03-removal.md) |
| 4 | ingest.ts 분해 | 1.5주 | [04-ingest-refactor.md](./04-ingest-refactor.md) |
| 5 | chat.ts 분해 | 1주 | [05-chat-refactor.md](./05-chat-refactor.md) |
| 6 | Wiki LLM 완성 (queryWiki + lint + 시간 메타) | 2.5주 | [06-wiki-completion.md](./06-wiki-completion.md) |

**총 ~9주.**

## Phase 의존성

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                                        │
                                        ▼
                              Phase 4 ──► Phase 5 ──► Phase 6
```

- Phase 0 산출물 (마크 모델 + interface) 없이 Phase 1 시작 불가.
- Phase 2 완료 시 proof-server 호출이 0이 되어 Phase 3 가능.
- Phase 4/5 는 순수 리팩토링 — 동작 변화 0. 늦어져도 사용자 가시 기능 영향 없음.
- Phase 6 의 `queryWiki` 만 Phase 5 보다 먼저 진행하는 대안 순서 가능 — 사용자 신호 조기 확보. [README 마지막 절 "순서 변경 옵션" 참조](#순서-변경-옵션)

## 핵심 invariant (모든 phase 가 지켜야 함)

각 phase 완료 시점에 다음이 모두 동작해야 한다:

1. 위키 페이지에서 AI 제안 accept → 페이지에 박힘 + 마크 메타 보존
2. 위키 페이지에서 AI 제안 reject → 마크 사라짐
3. Cmd+Z 한 단계로 accept 복원
4. daily 노트 저장 → 자동 ingest → 위키 페이지에 제안 박힘
5. 텍스트 선택 → MarkToolbar 에서 comment / replace / delete 생성
6. 마크 hover → popover 정상

**"전부 갈아엎고 마지막에 켜기" 절대 안 함.** Phase 단위로 머지 가능한 상태 유지.

## 보존 / 비목표

| 영역 | 처리 |
|---|---|
| 24개 커스텀 Milkdown 플러그인 (wikilink, daily, slash menu 등) | **전부 보존** |
| Hocuspocus / Yjs / IndexedDB 협업 인프라 | **보존** (Phase 3 이후에도 Yjs 자체는 계속 씀) |
| `apps/writer-tauri/src/export/` (현재 보류 중인 Export 기능) | 미머지 보존 |
| proof-sdk 멀티유저 협업, 코드블록 마크, frontmatter 마크 | 제거 (우리에게 무가치) |
| Drift 자동 보정 | **포기**. stale 표시로 대체. |

## 참조

- [reference/proof-sdk-surface.md](./reference/proof-sdk-surface.md) — proof-sdk 가 우리 코드 어디에 박혀 있는지 + 무엇을 제공하는지 맵

## 시간 / 사용자 가시 기능 일정

| 주차 | 작업 | 사용자 체감 |
|---|---|---|
| 1 | Phase 0 (명세) | 변화 없음 (기반 작업) |
| 2.5 | Phase 1 (markStore 구현) | 변화 없음 (호출자 없음) |
| 3.5 | Phase 2 (호출자 갈아끼우기) | 안정성 향상 (server 호출 사라짐) |
| 4 | Phase 3 (proof-sdk 제거) | 부팅 ↑ + 메모리 ↓ |
| 5.5 | Phase 4 (ingest 분해) | 변화 없음 (리팩토링) |
| 6.5 | Phase 5 (chat 분해) | 변화 없음 (리팩토링) |
| 9 | Phase 6 (queryWiki + lint) | **위키 질문 가능 + 위키 자동 정리** (신규) |

## 순서 변경 옵션

Phase 5 와 Phase 6.1 (queryWiki) 의 순서를 바꾸는 대안:

- **표준 순서** (4 → 5 → 6): 기반 안정 후 기능. 사용자 신호 9주차.
- **대안 순서** (4 → 6.1 → 5 → 6.2~6.3): Phase 4 끝나자마자 queryWiki. 사용자 신호 7주차. 단, chat.ts 분해 안 된 상태에서 queryWiki 추가 → 일시적으로 chat.ts 가 더 부어오름.

유저 0 시기일수록 신호 빨리 받는 게 중요. 대안 순서 검토 권장. 결정은 Phase 4 끝나는 시점에.

## 위험 완충

| 위험 | 완충 |
|---|---|
| Phase 0 명세가 모호하면 다음 phase 흔들림 | Phase 0 산출물을 코드 작성 전에 별도 PR 머지 후 다음 phase 시작 |
| 마크 스키마 교체 시 PM 스키마 차이로 데이터 마이그레이션 필요 | 유저 0 — dev DB 초기화. proof-sdk 마크 정의 그대로 베껴와서 호환 유지 |
| Phase 1~3 사이 시스템이 부분 동작 | 한 호출자씩 마이그레이션. proof-server 와 markStore 가 한동안 공존 |
| Phase 4/5 가 미묘한 의존 발견으로 지연 | 순수 리팩토링이라 사용자 영향 0. 미루기 쉬움 |
