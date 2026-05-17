# Proof-SDK 제거 + Wiki LLM 재구성 로드맵

> **Status (2026-05-17)**
>
> - **Phase 0 ~ 3 완료** — proof-sdk / proof-server / Hocuspocus 의존 0 달성. mark schema 자체 정의 + 좁힘 (`proofSuggestion` 15→3 attrs, `proofApproved` 제거, `proofFlagged` reserved). CollabStatus 좁힘 + IDB error wiring. Karpathy 평평 wiki 구조 + Bear 식 body-first title 정착. 잠재 버그 2건 fix (end-of-doc accept, auto-thread).
> - **Phase 4 (원래) — ingest.ts 분해 / Phase 5 — chat.ts 분해 / Phase 6 — queryWiki·lint·시간메타**: **연기**. 그 전에 더 근본적인 architecture pivot 이 들어감.
> - **새 Phase 4 — 파일 기반 architecture pivot** (다음): 위키 / 데일리 / chat 데이터를 IndexedDB 가 아니라 사용자 폴더의 마크다운 파일로 저장. CLI 도구 (grep / git / vim / qmd / MCP) 와의 결합 + 데이터 durability + Karpathy 패턴 종착점.
> - 옛 Phase 4/5/6 작업은 파일 기반 pivot 이 끝난 후 그 위에서 다시 진행 (위키 query 같은 새 기능은 파일 기반 위에서 더 자연스러움).
>
> 자세한 새 Phase 4 plan: [07-file-based-pivot.md](./07-file-based-pivot.md) (작성 예정 — Pre-Phase 4 설계 결정 후)

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

| Phase | 주제 | 상태 | 파일 |
|---|---|---|---|
| 0 | 기반 정의 (마크 모델 + interface + drift 정책) | ✅ 완료 | [00-foundation.md](./00-foundation.md) |
| 1 | 새 markStore in-memory 구현 | ✅ 완료 | [01-markstore.md](./01-markstore.md) |
| 2 | 호출자 갈아끼우기 (markActions, applyProposal, MarkToolbar, WikiPageBanner) | ✅ 완료 | [02-migration.md](./02-migration.md) |
| 3 | proof-sdk / proof-server 제거 | ✅ 완료 (3.A~3.G 까지 모두) | [03-removal.md](./03-removal.md) |
| **4 (새)** | **파일 기반 architecture pivot** — 위키/데일리/chat 데이터를 사용자 폴더의 .md 파일로 | 🚧 다음 | [07-file-based-pivot.md](./07-file-based-pivot.md) |
| 4 (구) | ingest.ts 분해 | ⏸ 연기 (새 Phase 4 후) | [04-ingest-refactor.md](./04-ingest-refactor.md) |
| 5 | chat.ts 분해 | ⏸ 연기 | [05-chat-refactor.md](./05-chat-refactor.md) |
| 6 | Wiki LLM 완성 (queryWiki + lint + 시간 메타) | ⏸ 연기 | [06-wiki-completion.md](./06-wiki-completion.md) |

**Phase 0~3 합 (완료): ~7주 실 작업.** 새 Phase 4 예상: ~6~8주.

## Phase 의존성 (수정)

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ✅ (완료)
                                        │
                                        ▼
                              [새 Phase 4 — 파일 기반 pivot]  🚧 다음
                                        │
                                        ▼
                              구 Phase 4 (ingest) ──► 구 Phase 5 (chat) ──► 구 Phase 6 (queryWiki / lint)
                                                                                  ⏸ 새 Phase 4 후 재배치
```

- Phase 0~3 완료. proof-sdk / proof-server / Hocuspocus 잔재 0.
- **새 Phase 4 (파일 기반 pivot)** 가 다음. 이게 끝나기 전엔 구 Phase 4/5/6 진행 안 함 — 어차피 파일 기반 위에서 다시 짜야 함.
- 구 Phase 4/5 (ingest / chat 분해) 는 순수 리팩토링 — 새 Phase 4 후에 자연스럽게 합치거나 그대로 진행.
- 구 Phase 6 (queryWiki / lint) 는 파일 기반 위에서 새 구현이 더 단순 (qmd 같은 도구 활용 가능). 통째로 재설계 가능성.

## 핵심 invariant (모든 phase 가 지켜야 함)

각 phase 완료 시점에 다음이 모두 동작해야 한다:

1. 위키 페이지에서 AI 제안 accept → 페이지에 박힘 + 마크 메타 보존
2. 위키 페이지에서 AI 제안 reject → 마크 사라짐
3. Cmd+Z 한 단계로 accept 복원
4. daily 노트 저장 → 자동 ingest → 위키 페이지에 제안 박힘
5. 텍스트 선택 → MarkToolbar 에서 comment / replace / delete 생성
6. 마크 hover → popover 정상

**"전부 갈아엎고 마지막에 켜기" 절대 안 함.** Phase 단위로 머지 가능한 상태 유지.

## 보존 / 비목표 (Phase 3 시점)

| 영역 | 처리 |
|---|---|
| 24개 커스텀 Milkdown 플러그인 (wikilink, daily, slash menu 등) | **전부 보존** |
| Hocuspocus | Phase 3.C 에서 제거 (원래 계획에선 보존이었으나 실제 작업에서 dep 까지 정리) |
| Yjs / IndexedDB | 새 Phase 4 까지 보존. 그 후엔 Yjs 는 편집 layer 로 유지, IDB 는 캐시/임시 역할로 축소 가능성. |
| `apps/writer-tauri/src/export/` (현재 보류 중인 Export 기능) | 미머지 보존. 새 Phase 4 가 파일 I/O 추가하면 export 와 통합 자연스러움. |
| proof-sdk 멀티유저 협업, 코드블록 마크, frontmatter 마크 | 제거 완료 |
| Drift 자동 보정 | **포기**. stale 표시로 대체. |

## 참조

- [reference/proof-sdk-surface.md](./reference/proof-sdk-surface.md) — proof-sdk 가 우리 코드 어디에 박혀 있는지 + 무엇을 제공하는지 맵

## 실제 진행 (완료분 기록)

| Phase | 사용자 체감 |
|---|---|
| 0 + 1 (markStore 기반) | 변화 없음 (기반 작업) |
| 2 (호출자 갈아끼우기) | 안정성 향상 (server 호출 사라짐) |
| 3.A~3.D (proof-server 제거) | 부팅 ↑ + 메모리 ↓ + 콘솔 에러 사라짐 |
| 3.E (mark schema 자체 정의화) | 변화 없음 (내부 정리) |
| 3.F (alias / type shim / dep / 잔재 청소) | 변화 없음 + **잠재 버그 fix** (ChatPanel 새 thread 자동 생성, IDB error 표면화) |
| 3.G (mark 종류 / attrs 좁히기) | 변화 없음 + **잠재 버그 fix** (end-of-doc accept) |

## 새 Phase 4 — 파일 기반 architecture pivot

**한 줄**: 위키 / 데일리 / chat 데이터를 IndexedDB 가 아닌 사용자 폴더의 마크다운 파일로 저장. ecosystem 결합 + 데이터 durability 가 목적.

**근거**:
- "CLI 도구도 쓰고 싶다" — 사용자가 명시한 신호. CLI 도구 (grep / git / vim / qmd / MCP) 는 다 파일 시스템 위에서 동작.
- Karpathy LLM Wiki 패턴의 종착점은 파일 기반 — 우리가 따라가는 source pattern.
- 데이터 가시성 = "Reliable, Wellmade" 가치의 한 축.
- 미래 AI 도구 (MCP 서버 들, Claude Agent SDK 의 file tools) 와의 결합 자연스러움.

**잃는 것** (의식적 수용):
- Y.Doc CRDT 의 atomic Cmd+Z 마법 — markStore 새 모양으로 다시 짜야 함
- 일부 무료 기능 (다중 cursor 등, 어차피 안 쓰는 거)
- 마이그레이션 비용 (한 번의 risk)
- 약 1~2개월 동안 새 기능 추가 0

**Sub-phase 분할 (예정)**:

| Sub | 내용 | 예상 |
|---|---|---|
| Pre-4 | 설계 결정 5가지 (폴더 layout / 마크 storage / 외부 도구 contract / multi-vault / 마이그레이션 전략) | 1~2일 |
| 4.A | 폴더 layout + 파일 I/O 기반 | 1주 |
| 4.B | 에디터 파일 binding (Y.Doc ↔ markdown 직렬화) | 1~1.5주 |
| 4.C | 마크 storage 새 모양 | 1~2주 |
| 4.D | 데일리 / wiki / system 페이지 마이그레이션 | 1주 |
| 4.E | file watch — 외부 변경 감지 | 며칠 |
| 4.F | chat thread 이주 | 며칠 |
| 4.G | IDB 잔재 제거 | 며칠 |

자세한 plan: [07-file-based-pivot.md](./07-file-based-pivot.md) (Pre-4 결정 후 작성)

## 위험 완충 (Phase 3 까지)

| 위험 | 완충 — 결과 |
|---|---|
| Phase 0 명세 모호 → 다음 phase 흔들림 | 명세 PR 분리. 효과 있었음. |
| 마크 스키마 교체 시 데이터 마이그레이션 | dev DB 정기 wipe. 큰 문제 없었음. |
| Phase 1~3 사이 부분 동작 | 한 호출자씩 마이그레이션. 잘 작동. |
| Phase 4/5 미묘한 의존 발견 지연 | (해당 없음 — 옛 Phase 4/5 진행 안 함) |

## 새 Phase 4 의 위험 완충 (예상)

| 위험 | 완충 |
|---|---|
| Cmd+Z atomicity 손실 | 4.C 에서 self-managed undo stack 또는 markdown inline mark 로 재설계. Phase 1~2 와 같은 디시플린 — 한 호출자씩 마이그레이션. |
| 마이그레이션 실패 시 데이터 손실 | dev 데이터 wipe 정기적이라 risk 낮음. 본격 사용자 생기기 전 완료가 목표. |
| 파일 I/O 의 race / atomic write 누락 | atomic write helper 한 곳에서 관리. file watch 와 우리 쓰기 구분 필요 — 4.E 의 핵심 작업. |
| 외부 도구 동시 편집으로 충돌 | 명시적 conflict UI (수동 머지) — 자동 머지 시도 안 함. |
