# MVP Scope — 출시까지 남은 것

작성: 2026-05-09
최종 갱신: 2026-05-09 (3/5 완료, 2개 deferred)
상태: **In progress** — 신뢰성 항목 3개 완료, 온보딩/배포 설정은 추후

> 코드베이스가 길어졌으니 MVP 범위를 락하고 하나씩 마무리한다.
> 원칙: Reliable + Wellmade. 사용자가 에러를 만나면 항상 무엇이 일어났는지 보여야 한다.

---

## ✅ 이미 동작 중 (그대로 유지)

- Tauri 셸 + Rust sidecar (proof-server) + Milkdown + Yjs collab
- Claude OAuth (PKCE + keychain) + claude-agent-sdk
- 멀티스레드 채팅 + 스트리밍 + 슬래시 커맨드 (`/review` `/polish` `/shorten` `/expand` `/outline`)
- proofSuggestion 마크 (생성 / 수락 / 거절 / Cursor-style 인라인 diff / 호버 액션바)
- 멀티 노트 + 데일리 저널 + 노트 트리 + 위키링크
- ⌘K 커맨드 팔레트 + 아카이브 / 복원
- Ingest 파이프라인 (idle trigger → proposals → 마크화) — 파이프 흐름

---

## 🟢 완료된 항목

### 1. ✅ 토스트 / 에러 가시화 — Done

Silent failure가 14자리 있어 사용자 입장에서 "버튼 눌렀는데 아무 일 없음"이 발생하던 것을 모두 토스트로 가시화.

**구현 내용**:
- `sonner@2.0.7` 도입 + 테마 인지 `<AppToaster>` 마운트
- `lib/notify.ts` 단일 헬퍼 모듈 — 14개 함수 (조용한 실패 사이트 = copy 한 곳에서 관리)
- 14자리 호출 사이트 연결:
  - **Mark 액션** (`markActions.ts`, `MarkToolbar.tsx`): markCantApply, markEditorNotReady, markCantRead, markCantDismiss, markCantAdd — 11 sites
  - **Note CRUD** (`docsStore.ts`): cantCreateNote, cantOpenJournal, cantDeleteNote, cantEmptyTrash, cantOpenNote — 8 sites (실패 시 Retry 액션 포함)
  - **Chat** (`ChatPanel.tsx`): threadLimitReached + Archive 액션 — 1 site
  - **Wikilink** (`WikilinkPalette.tsx`): wikilinkCreateFailed — 2 sites
- DevTools에서 `window.notify.<name>()` 호출로 12개 토스트 모두 시각 확인 완료

**중복 발화 회피**: `.catch(console.error)`는 디버깅용으로 남기되, 토스트는 단일 source(예: `docsStore` 액션, `ensureHandle`)에서만 발화하도록 정리.

**Auth 토스트는 정의됐지만 미연결**: `claudeSessionExpired`, `claudeSignInFailed`는 helper에 있지만 호출 사이트 없음 — 이미 ChatPanel의 "Connect to Claude" 오버레이 + ConnectClaudeDialog inline error + ErrorCard로 커버됨.

---

### 2. ✅ Rust panic 위험 제거 + 좀비 누수 회귀 수정 — Done

**원래 의도**: `lib.rs:305,348`의 `lock().unwrap()`이 poisoned mutex 시 앱을 panic시키는 위험 제거.

**실제 수정**: 단순 패치(`if let Ok`)가 아니라 **mutex 자체를 제거**:
- `Arc<Mutex<Option<Child>>>` → `AtomicI32` (pgid만 저장)
- `Child` 핸들은 spawn 직후 drop. `std::process::Child::drop`은 Unix에서 no-op이라 OS 프로세스는 계속 동작
- 종료 시 `libc::kill(-pgid, SIGTERM)`로 process group 전체에 시그널 — `setsid` in pre_exec 덕에 pid == pgid 보장
- mutex 자체가 없으므로 poison 발생 불가

**bonus 발견 + 수정 (회귀 아님, pre-existing)**:
- 검증 중 로그 분석으로 **Cmd+Q 경로에서 cleanup이 아예 발화 안 함** 발견
- `WindowEvent::Destroyed`는 X 버튼에만 발화, Cmd+Q는 `RunEvent::Exit` 경로
- 매 종료마다 proof-server 좀비가 port 4000을 점유한 채로 남음 → 다음 실행의 `kill_port_holders(4000)`이 청소
- `shutdown_proof_server()` 헬퍼 추출 → `swap(0)` 으로 idempotent → 두 종료 경로 모두에서 호출

**원래 리스트의 oauth.rs:201,236은 false alarm**: `unwrap_or_default()`로 이미 안전 처리됨. panic 위험은 lib.rs 2자리뿐이었음.

**Commit**: `b51a4060 fix(tauri): replace shared mutex with atomic pgid for proof-server cleanup`

---

### 3. ✅ proof-server 부트스트랩 안전망 — Done

엔진(proof-server)이 부팅 실패해도 앱은 그냥 진행 → 사용자는 빈 화면/무한 로딩만 보고 원인 모름. 이를 풀스크린 게이트로 가시화.

**구현 내용**:
- 새 IPC 커맨드 (`lib.rs`):
  - `check_proof_server_health` — 800ms 타임아웃으로 `/health` ping
  - `respawn_proof_server` — shutdown + spawn (Retry 버튼이 호출)
- 신규 컴포넌트 `<EngineGate>` (`components/EngineGate.tsx`):
  - 마운트 직후 250ms × 12회(총 3s) 폴링
  - 400ms 로더-딜레이 (빠른 콜드 스타트면 스피너 안 뜸)
  - 실패 시 테마-aware 에러 카드 (제목/설명/에러 디테일/Retry/Reload)
  - 'ready'는 terminal — 한 번 통과하면 재게이팅 없음
- `App.tsx` 리팩터: bootstrap-의존 훅들을 `<AppContent>` 서브컴포넌트로 추출 → 게이트 통과 후에만 발화

**검증**:
- 정상 부팅: 게이트 빠른 통과 (사용자 시각 확인)
- 영구 실패 시나리오: 사용자 스크린샷으로 에러 UI + Retry 동작 확인
- spawn-단계 실패 재현: `node_modules/proof-sdk/server/index.ts`를 일시 rename → 백그라운드 빌드 → 로그에 `[proof-server] proof-sdk server entry not found` 정확히 발화 확인

**Commit**: `89c7715d feat(engine): gate app behind proof-server health check`

---

## 🟡 출시 전 마무리 (deferred)

### 4. 🟡 온보딩 — Claude 미연결 상태 (deferred)

**문제 (분석 완료, 구현 deferred)**:

지금 사용자가 Claude 연결 안 한 상태로 앱을 켜면:
- 채팅 패널에 흐릿한 오버레이 + "Connect to Claude to start chatting" 글씨만 — **버튼 없음**
- 연결 다이얼로그는 사이드바 하단의 "Guest" 드롭다운 안에 숨어있음 → 발견 어려움
- Memory ingest는 Claude 미연결 시 **조용히 실패** + watermark만 올라가서 사용자가 인지 못함

**스코프 (확정)**:
- [ ] **A. ChatPanel 오버레이에 [Sign in to Claude] 버튼 추가** (~30분, 임팩트 큼)
- [ ] **B. `useIdleTrigger`에 auth-pre-check 추가** — 미연결이면 ingest skip + watermark 보존 (~20분)
- [ ] ~~C. 첫 실행 환영 화면~~ — 폴리싱 영역, 1.1로 미룸

**관련 파일**:
- `apps/writer-tauri/src/layout/ChatPanel.tsx:496` — 오버레이
- `apps/writer-tauri/src/hooks/useIdleTrigger.ts:88,164,178,247` — silent ingest 실패
- `apps/writer-tauri/src/hooks/useClaudeAuth.ts` — 연결 상태
- `apps/writer-tauri/src/components/auth/ConnectClaudeDialog.tsx` — 다이얼로그
- `apps/writer-tauri/src/stores/connectDialog.ts` — 다이얼로그 트리거 store

**의존 없음 — Claude Pro 미보유자 안내 등은 베타 피드백 후 결정**.

---

### 5. 🟡 tauri.conf.json — 배포 준비 (deferred)

**현재 상태**: `bundle.icon: []`, 사이닝 미설정, 업데이터 미설정.

**전제**: Apple Developer 멤버십 ✅ 보유 (별도 차단 없음).

**작업 순서 (확정)** — 인프라부터, 아이콘은 마지막:

| 순서 | 항목 | 영향 | 작업량 |
|---|---|---|---|
| 1 | 코드 사이닝 (Developer ID) | macOS Gatekeeper "Move to Trash" 차단 해제 | 1h |
| 2 | 노터라이제이션 | Gatekeeper 추가 경고 제거 | 30분 (사이닝 선행) |
| 3 | 자동 업데이트 (Tauri updater) | v0.1 → v0.2 푸시 가능 | 1~2h (GitHub Releases 호스팅) |
| 4 | 빌드 타겟 좁히기 (`"all"` → `["dmg","app"]`) | 빌드 시간 단축 | 5분 |
| 5 | CSP (`security.csp: null` → 명시적) | 보안 강화 | 1h+ (외부 리소스 검증 필요) |
| 6 | **앱 아이콘 (`.icns`) — 가장 마지막** | Dock/Spotlight 첫인상 | 30분 (디자인 후) |

총 ~5h. 배포 인프라(1~3)가 핵심, 4~5는 옵션, 6은 디자인 확정 후 마지막에 박음.

---

## 🟡 폴리싱 (MVP 같이 / 여유되면 / 또는 1.1)

- [ ] Bulk accept/reject (`⇧⌘A` / `⇧⌘R`) + 헤더 카운터 (roadmap PR 1-B)
- [ ] 위키 사이드바 빈 상태 헬프 텍스트 + 새 페이지 템플릿
- [ ] 매우 긴 문서 (>60K) 잘림 경고 (`DOC_CHAR_CAP`)
- [ ] 스레드 5개 한도 시 disabled 버튼 툴팁
- [ ] Stale ingest proposal 정리 (`ingestStore.ts:97-100`)

### 검증 중 발견된 별개 이슈 (MVP 외, 추후 검토)

- **`[collab] preserved non-authored marks from DB during projection materialization` 로그 스팸**:
  - 동일 슬러그/카운트로 30회 이상 연속 발화 (proof-server 부팅 직후)
  - 잠재적 비효율 또는 무한 루프 의심
  - proof-sdk 외부 패키지 측 이슈일 가능성 → 출시 전 한 번 들여다볼 가치
- **첫 실행 환영 화면**: 4번 항목의 옵션 C — 1.1 후보

---

## ❌ MVP 에서 제외 (베타 후 결정)

- **proofComment 마크 UI** — 스키마 / 렌더만 있고 생성 UI 없음. 1.1 로 미룸
- **Author stats 패널** (사람 / AI 비중) — 차별화 좋지만 베타 피드백 후
- **Wiki 정식 에디터** — textarea 충분
- **Memory writer 정식** (Extractor / Reconciler 분리) — 단순 ingest 로 충분
- **Sentry / telemetry** — no-op 헬퍼만, 출시 후 hook
- **자동 git 백업** (note-product-design Q4)
- **Multi-device sync** (proof-server 원격화)
- **멀티 에이전트 / 하네스 추상화** (P4 전체)

---

## 📦 출시 직전 체크리스트

- [ ] 미커밋 정리
- [x] 🔴 1번 완료
- [x] 🔴 2번 완료
- [x] 🔴 3번 완료
- [ ] 🟡 4번 (온보딩 A+B)
- [ ] 🟡 5번 (배포 설정)
- [ ] DMG 빌드 + 코드 사이닝 + 공증 (5번 후속)
- [ ] 베타 5–10 명 onboarding 메시지 + 채널
- [ ] 첫 주 모니터링 후 🟡 핫픽스
