# Memo: chat-INSERT 콘텐츠가 Keep 직후 서버에 의해 삭제되는 문제

작성: 2026-05-10
상태: **Resolved (2026-05-10)** — proof-sdk 정합 회귀 + Y.UndoManager 통합으로 해결
관련 Phase: Step 3 (commit `d9cbc540`)
관련 결정 ADR: `2026-05-10-proof-sdk-realignment.md`

---

## Resolution

이 메모의 진단 (PM-tree 모델 → proof-server guardrail 충돌) 은 정확했음. 해결은 **proof-sdk 패턴으로 회귀** 였음:

- ingest, chat-INSERT 모두 anchor-on-existing-text + Y.Map.content 모델로 복귀 (commits `dbf401fb`, `eea3e04b`, Phase 4)
- ghost widget INSERT 부활로 in-context preview UX 유지 (Cursor 식)
- 후속으로 발견된 dual-source-of-truth Cmd+Z 버그 (accept → undo → re-accept) 는 `Y.UndoManager` 통합으로 근본 해결 (commit `ffab86f4`)

자세한 결정 / 교훈은 follow-up ADR 참조.

---

---

## 증상 (사용자 보고)

1. chat 에 "에디터에 200자 정도 텍스트 넣어줘" 요청
2. 초록 점선 블록으로 콘텐츠 박힘 (Step 3 가 Phase 1 패턴 적용 — 정상)
3. **× (Reject)** 누르고 Cmd+Z → **정상 동작** (블록 삭제 → 복원)
4. **Keep (Accept)** 누름 → **마크 영역의 콘텐츠가 통째로 사라짐**

마치 Keep 이 reject 처럼 동작.

전제: **어제까지는 chat 콘텐츠 주입이 정상** 이었음. Step 3 머지 (오늘) 이후 발생.

---

## 진단 결과 — `acceptMark` 는 무죄

`apps/writer-tauri/src/editor/markActions.ts:acceptMark` 의 INSERT 분기에 임시 진단 로그를 깔고 추적:

```
[1] 우리 transaction (acceptMark 가 dispatch):
    stepTypes: removeMark[150-185], removeMark[187-350],
               addMark[150-185], addMark[187-350]
    beforeSize: 359, afterSize: 359   ← 콘텐츠 0 변경

[2] 그 직후 들어오는 외부 transaction:
    stepTypes: replace[0-359]          ← 전체 doc 교체
    beforeSize: 359 → afterSize: 324   ← 35 chars 삭제 (직접적인 dup)

[3] 또 외부 transaction:
    stepTypes: replace[0-324]          ← 전체 doc 교체
    beforeSize: 324 → afterSize: 161   ← 163 chars 삭제 (Tom 단락)

[4] final size: 161 (= 마크된 198 chars 정확히 사라짐)
```

→ **acceptMark 의 PM transaction 은 마크만 변경, 콘텐츠 유지.**
→ **그 다음에 들어오는 두 개의 `replace[0-N]` transaction 이 콘텐츠 삭제.**

`replace[0-doc전체]` 형태의 transaction = **y-prosemirror 가 외부 (= Yjs ydoc) 변경을 PM 으로 흘리는 패턴**. 즉 **누군가 ydoc 을 수정 → y-prosemirror 가 PM 동기화**.

그 "누군가" = **proof-server 의 reconciliation guardrail** (가능성 ~99%).

---

## 왜 서버가 되돌리는가

코드베이스 자체에 명문화된 패턴 (`apps/writer-tauri/src/agent/applyIngest.ts:25-30`):

> proof-server keeps two representations of a doc — the y-prosemirror XmlFragment and a server-side markdown projection. PM transactions are the only path the server's projection guardrails consider canonical; raw Y.XmlElement inserts can drift, the server detects the drift, and **"repairs" by reverting our write** (we observed exactly this — a paragraph appeared and then vanished a second later).

= 서버는 자기 markdown projection 과 안 맞는 변경을 발견하면 클라가 한 변경을 되돌림.

이번 케이스의 추정 흐름:

```
[t1] Keep 클릭
[t2] acceptMark dispatch
     PM: proofSuggestion 제거 + proofProvenance 추가
     → y-prosemirror: Yjs binary 변경 인코딩
     → Hocuspocus: 서버에 송신
[t3] 서버 (proof-server):
     수신 → markdown projection 시도
     ★ 어떤 이유로 chat-INSERT 단락들이 "drift" 로 판단됨
     → 서버가 "복원" 업데이트 송신 (각 단락별 한 번씩)
[t4] 클라 y-prosemirror: 두 replace 업데이트 적용
     → 두 chat-INSERT 단락 사라짐
     → final size: 161
```

---

## 왜 어제까지는 동작했나

| | 어제 (Step 3 전) | 오늘 (Step 3 후) |
|---|---|---|
| chat-INSERT 가 가는 길 | 옛 `applyProposal` INSERT 분기 | 새 `materializeInsert` |
| PM 트리에 넣는 것 | 기존 단어에 placeholder 마크 | **새 콘텐츠 통째 + 마크** |
| Y.Map.content | 새 콘텐츠 보관 (서버는 이걸 이해) | 안 씀 |
| 서버가 보는 변화 | 마크만 추가 (사용자 글은 그대로) | **새 단락 등장** (서버 입장에선 "drift") |

→ **Step 3 가 chat-INSERT 콘텐츠를 PM 트리에 직접 박는 모델로 바꾸면서, 서버의 "이 콘텐츠 어디서 왔지?" 판단을 trigger.**

옛 모델은 사용자의 doc 자체엔 변화 없고 마크만 추가 → 서버가 의심할 게 없음 → roundtrip 통과.
새 모델은 doc 에 새 단락 추가 → 서버가 "내가 모르는 단락이네" 판단 → 되돌림.

---

## 왜 ingest 는 동작하고 chat 만 깨지나 (추정)

| | ingest INSERT | chat INSERT |
|---|---|---|
| 페이지 사전 콘텐츠 | 빈/sparse 페이지 (위키 첫 진입) | 풍부한 기존 콘텐츠 (사용자 노트) |
| 삽입 위치 | 항상 pos 0 | quote 기반 (기존 단락 사이) |
| 서버 markdown 변화 | "빈 → 새 단락" — 단순 | "기존 + 새 단락 + 새 단락(dup)" — 복잡 |
| 서버 판단 | OK (단순한 추가) | Drift (복잡, dup) → revert |

(이번 케이스에선 LLM 이 chat 응답에 **기존 단락의 마지막 문장을 또 그대로 emit** 한 것도 한 몫. 서버가 dup 을 더 강하게 의심.)

⚠️ 단, **ingest 도 같은 잠재 문제가 있을 가능성** — 단지 시나리오가 단순해서 발동 안 했을 뿐. 진짜 검증 필요.

---

## 재현 절차

1. 위키 페이지에 충분한 기존 콘텐츠 두기
2. chat 에 "이 페이지에 새 단락 추가해줘" (LLM 이 INSERT 종류로 propose_change 호출하도록 유도)
3. 초록 점선 보임 → Keep 누름
4. 1~2초 내 콘텐츠 사라짐

진단 로그가 필요하면 commit `d9cbc540` 의 acceptMark 에 임시 추가 가능 (이미 제거됨).

---

## Decision — 클라 측 추가 작업 보류

**root cause 가 proof-server 측** 이므로 markActions 코드 수정으로 해결 불가.

지금까지 클라 측에서 한 모든 작업 (Phase 1, A, B, Step 1-3) 은 **본질적으로 정상**. 서버 정합 안 됨이 발견될 뿐.

### 다음 행동 (우선순위 순)

1. **proof-server 측 점검 필요**:
   - 서버의 PM 스키마에 `proofProvenance`, 그리고 Step 1 에서 추가한 `proofSuggestion` 의 새 attrs (sourceSlug 등) 가 동기화 됐는가
   - 서버의 reconciliation guardrail 이 어떤 조건에서 발동하는가
   - 서버가 "drift" 로 판단하는 정확한 기준
   - 서버 로그 / Hocuspocus 미들웨어 점검

2. **임시 mitigation 옵션** (서버 fix 전 클라 측 우회):
   - **A. Step 3 부분 revert**: chat-INSERT 를 다시 옛 applyProposal 흐름으로 → 동작은 되지만 ingest 와 비대칭, 콘텐츠 안 보임
   - **B. proofAuthored 마크 함께 stamp**: 새 단락에 "사용자 author 가 만든 콘텐츠" 라는 마크도 추가해서 서버 guardrail 우회 시도 (실험 필요)
   - **C. Y.Map.content mirror 유지**: 서버가 Y.Map 본문도 기준으로 삼는다면 mirror 만 추가해도 통과 가능 (실험 필요)

3. **ingest INSERT 동일 문제 가능성 검증**:
   - ingest 마크에서도 long content + 풍부한 기존 페이지 시나리오로 Keep → 콘텐츠 살아남는지
   - 동일 현상 재현되면 **Step 1 도 영향** — 우선순위 상향

---

## 진행 중 작업 / 영향

- ✅ Step 1 (ingest provenance → mark.attrs): 머지됨 — 잠재 영향 가능, 검증 필요
- ✅ Step 2 (comment text/quote → mark.attrs): 머지됨 — comment 흐름은 보통 단단어 anchor 라 영향 작을 듯, 검증 필요
- ✅ Step 3 (chat-INSERT materialize): 머지됨 — **이 issue 의 trigger**
- ⏸ Step 4 (chat REPLACE content → mark.attrs): **보류**. Step 3 이슈 해결 전엔 같은 함정 가능성

---

## 메모 — 조사 시작 단서

서버 측 점검 시 봐야할 것:
- `proof-server` 의 PM 스키마 정의 위치
- Hocuspocus extension 들 (특히 reconciliation 관련)
- `markdown projection` 코드 — 어떤 마크/콘텐츠를 round-trip 못 하는지
- 최근 변경 사항 (어제까진 동작했으므로 — 환경/디플로이/세팅 변경 가능성)

---

## 한 줄 요약

**chat-INSERT 가 Step 3 부터 콘텐츠를 PM 트리에 직접 박는 모델로 바뀌면서, proof-server 의 reconciliation guardrail 이 그 콘텐츠를 "drift" 로 판단해 되돌리는 현상.** 클라 측 acceptMark 는 정상 동작. **서버 측 정합 작업이 다음 게이트.**
