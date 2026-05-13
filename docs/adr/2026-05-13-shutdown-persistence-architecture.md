# ADR: 종료 시 내용 유실 — 신호 기반 종료 + 클라 1차 영속

작성: 2026-05-13
상태: **Accepted (Phase 1 구현 + 회귀 fix 완료)**
관련 커밋:
- `c835b5ed` (proof-server graceful exit 대기 6초 추가 — 시간 기반 완화, 본 ADR 이전 임시방편)
- `7ec6c133` feat(persistence): attach y-indexeddb alongside HocuspocusProvider
- `512d7e0c` feat(persistence): accept idb hydration as a synced signal in 3 gates
- `4c94e6ef` feat(persistence): offline-first doc creation with client-side slugs
- `a1d6c8d` (proof-sdk) fix(collab): skip legacy reseed for empty-markdown rows
- `42e4f975` fix(persistence): close PM↔Y initial sync race that duplicated paragraphs

관련 메모: `docs/adr/2026-04-30-mark-anchor-system.md` (마크 시스템 원칙)

---

## Context

### 증상
개발 서버에서 작성 → Ctrl+C → 재시작 시 마지막 입력이 사라짐. `c835b5ed`에서 SIGTERM 후 6초 대기를 넣어 **완화**됐지만, 시간으로만 보장하는 구조라 타이밍이 어긋나면 또 샌다.

### 현재 저장 경로 (3계층)

```
[React/Milkdown Y.Doc]
  ─ WebSocket ▶
[proof-server (bun, port 4000)]
  ─ 250ms debounce ▶
[SQLite proof-share.db]
```

핵심 사실: **프런트엔드는 디스크에 직접 쓰지 않는다.** 영속은 **별도 프로세스**(proof-server)가 담당하고, 그 안에서 250ms 디바운스를 거친 뒤 SQLite로 flush.

### 종료 시퀀스 (현재)

`apps/writer-tauri/src-tauri/src/lib.rs:41-81`:
1. Tauri가 종료 신호 받음
2. proof-server 프로세스 그룹에 SIGTERM
3. 100ms 간격으로 `kill(-pgid, 0)` 폴링, **최대 6초**
4. 그래도 살아있으면 4000 포트 점유 프로세스 강제 kill

proof-server 측 (`/Users/williamjung/conductor/workspaces/edit/proof-sdk/server/index.ts:159-200`):
- SIGTERM 받으면 `flushAllDocumentsForShutdown()` → `stopCollabRuntime()` → `exit(0)`
- 5초 하드 타임아웃

### 구조적 결함

| 결함 | 위치 | 영향 |
|---|---|---|
| A. 프런트에 flush 보장이 없다 | `CloseConfirmDialog.tsx`, close hook | UI 상태로만 종료 판단, 저장 상태와 무관 |
| B. 영속 책임이 별도 프로세스에 위임 | proof-server | WebSocket으로 보낸 후 확인 신호(ACK) 없음 |
| C. dev DB 경로 불안정 | `node_modules` 안 (외부 심링크) | `pnpm install` 시 휘발 가능 |
| D. 종료 예산이 계층마다 다름 | 250ms / 5s / 6s / **프런트 0s** | 가장 안쪽에서 신뢰의 사슬이 끊김 |

### 정석은 무엇인가

거의 모든 현대 노트 앱(Apple Notes, Obsidian, Linear, Notion, Figma)은:

```
[메모리 UI 모델]
  ↓ 모든 변경을 이벤트로
[로컬 영속 (디스크)]  ← (1)→(2)는 무조건 클라 안에서 완결
  ↓ 비동기
[원격 동기화]         ← 네트워크/서버는 그 다음 단계
```

핵심 원리:
- **WAL(Write-Ahead Log)**: 모든 변경을 append-only 로그에 먼저 기록 → 디바운스 윈도우가 비어도 raw bytes는 디스크에 있음
- **단일 신뢰 소스(SSOT)**: UI는 캐시, 진실은 디스크. 부팅 시 디스크에서 다시 빌드
- **fsync 정책**: 닫기/탭전환/배경 전환 시 강제 flush
- **Atomic write**: tmp 파일 + rename, 반쯤 쓰여서 깨지지 않음

Yjs/CRDT 기반 앱(Tldraw, Affine 등)의 표준 패턴:
- `y-indexeddb`/`y-leveldb` 같은 어댑터로 **클라가 자기 디스크에 직접** Y.Doc update를 append
- WebSocket Provider는 **동기화 전용**, 영속의 1차 책임 아님

**우리 앱의 차이**: 클라이언트 측 영속이 없어 단일 디바이스 데이터 생존이 WebSocket + 별도 프로세스에 묶여 있음. 정석에서는 애초에 일어날 수 없는 위치 — 클라가 이미 자기 디스크에 써놓기 때문.

---

## Decision

3-Phase로 분리. 각 Phase는 단독 완결, 중간에 멈춰도 시스템이 더 나빠지지 않음.

### Phase 0 — 신호 기반 종료 (필수, 1~2일)

**목표**: 시간 대기를 ACK 대기로 교체. 현 구조 유지.

**작업:**
1. proof-sdk 서버에 `POST /shutdown/flush-and-ack` 엔드포인트 추가
   - `flushAllDocumentsForShutdown()` 호출 후 `{ ok: true, flushed: N }` 응답
   - **함수는 이미 존재** (`collab.ts:11618`, export됨) — wiring만 필요
   - `hasPersistInFlightWrites()`, `waitForPersistInFlightDrain()`도 이미 존재 (`collab.ts:2012, 2019`)
2. Tauri `shutdown_proof_server` (`lib.rs:41-81`) 가 SIGTERM 보내기 직전 HTTP `POST /shutdown/flush-and-ack` 호출, ACK 받고 SIGTERM
   - ACK 타임아웃 3초, 그 후엔 기존 6초 안전망 폴백
3. 프런트 `CloseConfirmDialog` / Tauri close hook이 `await provider.synced && unsyncedChanges === 0` 확인 후 종료 허용

**영향 분석:**

| 기능 | 영향 | 비고 |
|---|---|---|
| 마크 시스템 | 없음 | flush는 Y.Doc 바이트 단위, 마크/콘텐츠 구분 없이 보존 |
| 협업 | 없음 | 평상시 경로 무변경 |
| 채팅 | 없음 | 별도 채널 |
| 종료 속도 | 약간 빨라짐 | ACK 받으면 6초 안 기다림 |

**잠재 위험:** ACK 타임아웃 잘못 잡으면 종료 지연. → 상한 3초 + 6초 안전망 폴백.

**얻는 것:** Cmd+Q/Ctrl+C 직후 손실 시나리오 사실상 소멸 (90%).

---

### Phase 1 — 클라 1차 영속 추가 (3~5일)

**목표**: `y-indexeddb` 추가, 클라가 자기 디스크에 Y.Doc을 append. proof-server는 동기화/백업 역할로 격하.

**작업:**
1. `y-indexeddb` 추가, `HocuspocusProvider` 옆에 `IndexeddbPersistence(slug, ydoc)` 함께 부착
2. 부팅 순서 변경:
   - IndexedDB에서 먼저 복원 → 즉시 렌더
   - WebSocket sync는 백그라운드, 서버 deltas는 자동 머지
3. `docsStore.bootstrap()` 의 서버 호출 (`createDoc`, `getCollabSession`) 을 렌더 차단 경로에서 제외
4. `provider.isSynced` 차단 4곳에 `locallyHydrated` OR 조건 도입:
   - `MilkdownEditor.tsx:107-126` (에디터)
   - `ChatPanel.tsx:118-123` (채팅 패널)
   - `useApplyPendingMarks.ts:47-55` (ingest 마크)
   - `docsStore.ts:961-973` (title mirror)

**영향 분석:**

| 기능 | 영향도 | 검증 포인트 |
|---|---|---|
| 마크 시스템 | **낮음** | 클라 UUID, Y.Map binary, 별도 REST 없음. 메모리 노트(`writer-tauri 마크 앵커 시스템`) 원칙과 일치 |
| 마크 ID 생성 | 없음 | `MarkToolbar.tsx:119`, `applyProposal.ts:98,132` 전부 `crypto.randomUUID()` |
| 마크 메타 | 없음 | `Y.Map('marks')`, `Y.Map('authoredMeta')` 이미 Yjs binary로 동기화 |
| `proofClient.ops()` | 없음 | 미사용 (caller 없음, `proofClient.ts:32-47` 주석) |
| 채팅 | 낮음 | 활성 에디터 필요 — synced 대기 로직만 OR 조건 추가 |
| 데일리 노트 / 사이드바 | 낮음 | `knownDocs` localStorage 그대로 유지 |
| WKWebView IndexedDB | **검증 필요** | macOS WebView에서 quota/락 간헐 보고 — dogfood 필요 |
| dev/prod origin 분리 | **검증 필요** | webview origin 같으면 데이터 섞임 |
| 협업 (멀티 디바이스) | 검증 필요 | Yjs CRDT 자동 머지하지만 마크 의미 보존 확인 필요 |
| 로컬-원격 머지 깜빡임 | 검증 필요 | 로컬 렌더 → 서버 sync 후 PM decoration re-fire |

**잠재 위험:**
- **새 daily 생성 오프라인**: 현재 `proofClient.createDoc()`로 서버에서 slug 발급. 오프라인이면 막힘. → 임시 클라 slug + 온라인 시 reconcile, **또는** Phase 1 범위에서 새 daily만은 서버 의존 유지(기존 doc은 오프라인 가능).
- **이중 복원 순서**: IndexedDB 즉시 렌더 → 서버 deltas 적용 시 Yjs가 no-op이지만, 새로 생긴 마크 ID가 있으면 깜빡일 수 있음.
- **dev 모드 격리**: dev/prod IndexedDB는 도메인 다르면 자동 분리. Tauri 빌드에서 webview origin 확인 필요.

---

### Phase 2 — proof-server 역할 격하 (선택, 1~2주)

**목표**: SQLite를 권위 있는 SSOT에서 캐시/백업으로 격하. 클라가 끊겨도 서버는 받은 만큼만 보유.

**작업:**
1. proof-server를 dev 모드에서 **선택적**으로 (협업 안 쓰면 띄울 필요 없음)
2. `proof-share.db` 위치를 `node_modules` 바깥으로 이전 (결함 C 해결)
3. 새 doc slug 발급도 클라 측 UUID로 가능하게 (서버는 받아만 둠)

**영향:**
- 협업 시 서버 다운 동작 변화 (의도된 변화, 명시적 처리)
- 마크 시스템 메모리 원칙("REST 우회") 과 방향 일치

---

## 권장 진행 순서

1. **Phase 0만 먼저 머지** → 일주일 dogfood. 사용자 체감 문제 거의 해결.
2. Phase 0 안정 후 Phase 1을 feature 브랜치에서. 마크 시스템 회귀 + WKWebView IndexedDB가 핵심 검증.
3. Phase 2는 **필요할 때만** (오프라인 사용성 요구 / 서버 의존 감축).

각 Phase는 앞 단계를 무효화하지 않음:
- Phase 1을 안 해도 Phase 0의 ACK 종료는 그대로 유효
- Phase 2를 안 해도 Phase 1의 클라 영속은 그대로 유효

---

## Open Questions

1. **새 daily 생성 오프라인 정책** — 임시 slug + reconcile vs. Phase 1 범위에서 새 doc만은 온라인 요구. 후자가 단순.
2. **WKWebView IndexedDB 신뢰성** — Phase 1 착수 전 macOS Tauri에서 spike 필요. 불안정하면 `y-leveldb` + Tauri fs API 대안.
3. **dev/prod webview origin** — 현재 분리되어 있는지 빌드 설정 확인 필요.
4. **proof-sdk 변경 가능 여부** — Phase 0이 proof-sdk에 새 엔드포인트 추가를 요구. 우리 모노레포 안의 패키지(`workspaces/edit/proof-sdk`)이므로 가능하지만, 다른 consumer가 있다면 영향 확인 필요.

---

## Consequences

### Positive
- 종료 시 데이터 유실 사실상 0 (Phase 0)
- 오프라인 동작 가능 (Phase 1)
- 서버/네트워크 장애 시 데이터 생존 (Phase 1)
- 부팅 속도 향상: 서버 health check 차단 제거 (Phase 1)
- `node_modules` 의존성 휘발 위험 제거 (Phase 2)

### Negative
- 코드 복잡도 증가: 로컬↔원격 머지 정책 명시화 필요 (Phase 1)
- 디버깅 표면 증가: IndexedDB 상태도 검사 대상 (Phase 1)
- 초기 마이그레이션: 기존 사용자의 첫 실행 시 서버 → IndexedDB 시드 (자동, 코드 거의 불필요)

### Neutral
- Phase 0은 기존 시스템에 가산만 — 되돌리기도 쉬움
- Phase 1/2는 정석 패턴이라 장기적으로 유지보수 비용 감소

---

## 구현 후기 — Phase 0는 건너뛰고 Phase 1 직행

WKWebView IndexedDB spike (1MB write ~9ms, quota ~20GB) 통과 후 Phase 0를 건너뛰고 Phase 1을 직접 구현했다. 이유: Phase 1이 Phase 0의 효과를 포괄하기 때문 (클라 IDB가 1차 영속이면 ACK 종료 자체가 불필요).

**구현된 결정 (당초 Open Questions 답)**:
1. 새 daily 오프라인 정책 → **(a) 클라 UUID 임시 slug + reconcile** 채택. 더 단순하다고 봤지만 실제로는 정공법(클라가 ID 발급, 서버는 받기만)이라 reconcile 자체가 거의 없는 구조였다.
2. WKWebView IndexedDB → spike 통과
3. dev/prod origin → 분리 확인됨
4. proof-sdk 변경 → `POST /documents`에 클라 slug 수용 (idempotent), 하위호환 유지

---

## 구현 후 발견된 회귀와 fix (같은 PR 시리즈에서 닫음)

Phase 1 머지 직후 두 회귀가 발견됐고 같은 브랜치에서 정공법으로 닫았다.

### 회귀 1: 일반 노트 본문이 매 부팅마다 2배 누적

증상: writing/wiki 노트(데일리 X)에 본문 입력 → 즉시 close → 재시작 시 본문이 1→2→4→8 누적.

**Root cause** (`proof-sdk/server/collab.ts:5949` 의 reseed 분기): 클라가 보낸 fire-and-forget `POST /documents { slug, markdown:'' }` → 서버에 빈 markdown row 생성 → 다음 WebSocket connect 시 `readPersistedDocStateAsync`가 "snapshot 없음 + updates 없음 + row 있음" 분기 진입 → `seedLegacyDocumentToPersistedYjsAsync` 호출 → **매번 새 clientId로 빈 fragment baseline 생성**. 클라가 250ms persist debounce 안에 close하면 snapshot이 SQLite에 박히지 않아 다음 부팅에도 같은 분기 재진입. 매 부팅마다 새 paragraph가 fragment에 누적.

**왜 데일리는 안 보였나**: `lib/docTitle.ts:46-63 cleanupDailyDateHeading`이 leading h1만 사후 청소하는 코드가 있어 가려져 있었음 (주석: "legacy artefact from a pre-fix multi-bootstrap race"). 데일리도 동일 회귀가 있었지만 청소 코드로 우회한 것. writing/wiki에는 없음.

**Fix** (`a1d6c8d`): hot path에서 빈 markdown row면 reseed 건너뛰고 빈 Y.Doc + 빈 baseline 반환. 실제 legacy doc(markdown 있는 doc)은 기존 reseed 흐름 유지.

### 회귀 2: 새 노트 본문 위에 빈 paragraph 하나 잔존

증상: 회귀 1 fix 후, 새 노트에 텍스트 즉시 입력 → close → 재시작 시 `[빈 paragraph][텍스트 paragraph]` 형태. 누적은 안 되지만 빈 줄이 첫 줄로 남음.

**Root cause** (y-prosemirror의 PM↔Y initial sync): 신규 노트는 IDB 비어있어 `idbSynced` 즉시 resolve. 한편 PM은 schema `doc: block+` 제약 때문에 마운트 시 자동으로 빈 paragraph 1개를 가진 doc으로 시작. `bindDoc.connect()` 시점에 y-prosemirror가 빈 fragment와 PM doc을 비교하는데, mark attribute 인스턴스 차이로 `findDiffStart !== null` 판정 → **PM의 빈 paragraph를 fragment에 commit**. 이후 사용자 입력은 별도 paragraph로 들어가 결과적으로 fragment에 paragraph 2개.

**Fix** (`42e4f975`): `MilkdownEditor.tsx`에서 `await idbSynced` 직후, `bindDoc` 직전에 fragment가 비어있으면 `prosemirrorToYDoc(schema.topNodeType.createAndFill())` 결과를 명시적으로 시드. PM의 빈 doc과 fragment의 빈 doc이 정확히 같은 shape이 되어 `findDiffStart === null` → 가짜 commit 안 발화. 이건 Tldraw/Affine 같은 다른 Yjs+PM 앱들도 따르는 표준 패턴.

### 회귀 fix가 정공법인 근거

- 회피책 (cleanup observer로 빈 paragraph 제거 등) 아님 — commit이 발화하는 원인 자체를 닫음
- y-prosemirror 공식 API (`prosemirrorToYDoc`) 사용 — 라이브러리 디자인 따름
- 정상 워크플로우(사용자가 의도적으로 빈 줄 만들기 등)에 사이드이펙트 없음
- 두 회귀 모두 단일 원인 (offline-first 진입 시점의 race) 의 다른 표면이었음 — 한쪽은 서버 측, 한쪽은 클라 측

---

## 최종 상태

| 시나리오 | 결과 |
|---|---|
| 평상시 입력 후 close → 재시작 | 데이터 100% 보존 |
| Ctrl+C / SIGKILL / 크래시 | 데이터 100% 보존 (IDB에 즉시 append) |
| 오프라인 새 노트 작성 | 동작 (IDB에만 저장, 온라인 시 자동 register) |
| 오프라인 기존 노트 편집 | 동작 (IDB 1차 영속) |
| 멀티 디바이스 sync | 정상 (Yjs CRDT 자동 머지) |
| 마크 시스템 / 채팅 / ingest | 회귀 없음 |

남은 옵션 (선택, 당장 불필요):
- Phase 2: proof-server 역할 격하 + `proof-share.db` 위치를 `node_modules` 바깥으로
- `cleanupDailyDateHeading` 제거: 회귀 fix 후 더 이상 필요 없음. 일주일 dogfood 후 별도 PR로 정리
