# MVP Scope — 출시까지 남은 것

작성: 2026-05-09
상태: **Locked** — MVP 스코프 확정

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

## 🔴 MVP 출시 차단 (반드시 마무리)

### 1. 토스트 / 에러 가시화

지금 silent failure 가 너무 많다. 사용자 입장에서 "버튼 눌렀는데 아무 일 없음" 이 발생.

- [ ] `sonner` 도입 + Toaster mount (`App.tsx`)
- [ ] `ChatPanel.tsx:707` 의 "TODO real toast" 처리
- [ ] 마크 액션 실패 시 사용자 피드백 (`markActions.ts:90,125,130` silent return)
- [ ] ingest / applyPendingMarks 실패 토스트
  - `useIdleTrigger.ts:88,164,178,247`
  - `useApplyPendingMarks.ts:102,126`
  - `applyIngest.ts:67,252`
- [ ] 채팅 rate limit / 네트워크 / OAuth 만료 분기는 `errorMessage.ts` 에 이미 있음 — 토스트만 연결

### 2. Rust panic 위험 제거

- [ ] `src-tauri/src/lib.rs:305,348` `lock().unwrap()` — poisoned mutex 시 앱 죽음 → graceful 에러
- [ ] `src-tauri/src/oauth.rs:201,236` HTTP fail unwrap → graceful 반환

### 3. proof-server 부트스트랩 안전망

- [ ] `proofClient.ts:waitUntilReady` 10s 타임아웃 후 silent → "서버 시작 실패" 화면 + 재시도 버튼
- [ ] sidecar 바이너리 누락 시 명확한 에러 메시지
- [ ] `pack-sidecar.sh` 실패 모드 점검

### 4. 온보딩 — Claude 미연결 상태

- [ ] 현재 ChatPanel 위 흐릿한 오버레이만 → 강한 Connect CTA 또는 스플래시
- [ ] Claude Pro 미보유자 안내 (옵션 A 운영 원칙: `plan.md §12`)

### 5. tauri.conf.json — 배포 준비

- [ ] `sign` (Developer ID) + notarize 설정
- [ ] `updater` 블록
- [ ] DMG 아이콘 (현재 `"icon": []`)

---

## 🟡 폴리싱 (MVP 같이 / 여유되면 / 또는 1.1)

- [ ] Bulk accept/reject (`⇧⌘A` / `⇧⌘R`) + 헤더 카운터 (roadmap PR 1-B)
- [ ] 위키 사이드바 빈 상태 헬프 텍스트 + 새 페이지 템플릿
- [ ] 매우 긴 문서 (>60K) 잘림 경고 (`DOC_CHAR_CAP`)
- [ ] 스레드 5개 한도 시 disabled 버튼 툴팁
- [ ] Stale ingest proposal 정리 (`ingestStore.ts:97-100`)

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
- [ ] 🔴 1–5 모두 완료
- [ ] DMG 빌드 + 코드 사이닝 + 공증
- [ ] 베타 5–10 명 onboarding 메시지 + 채널
- [ ] 첫 주 모니터링 후 🟡 핫픽스
