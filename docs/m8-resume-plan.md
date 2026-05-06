# 다음에 할 것 — Live next-steps

작성: 2026-05-01 (초기) / 갱신: 2026-05-06
상태: M7 완료 후 노트앱 폴리싱/확장 단계

---

## 지금까지 한 것 (요약)

### M0–M7 (Tauri 재구축, 자세한 진척: `path-b-rewrite-plan.md` §8)
- ✅ Tauri 셸 + Rust sidecar (proof-server) + Milkdown + Yjs collab
- ✅ Mark schema + hydration + cleanup plugin (단일 앵커 통일)
- ✅ Mark popover accept/reject
- ✅ Claude OAuth (PKCE + Rust keychain) + Anthropic SDK via Rust proxy

### M8 — Chat Panel & 슬래시 커맨드
- ✅ M8.3 ChatPanel + ProposalSnippet (M8.3 Phase 1-4 완료)
- ✅ Phase 5 자유 채팅 (Step 1–6 완료, Step 7 일부)
  - Y.Doc 안 multi-thread (max 5 active + soft archive)
  - Streaming + Streamdown 마크다운 렌더
  - propose_change tool 시각화 + 인라인 마크 자동 생성
  - selection chip + frozen selection
- ✅ 슬래시 커맨드 프레임워크 (3 kinds: chat-message / document-edit / review-comments)
  - `/proofread` (구 review), `/polish` `/shorten` `/expand`, `/outline`
- ✅ Run Review 버튼 제거 → `/review` 슬래시로 통합

### 노트 제품 골격 (`note-product-design.md` Q1–Q12 매핑)
- ✅ 멀티 문서 탭 (writing 노트 다중)
- ✅ 일별 노트 (Daily journal, Mon-anchored 7-day backfill)
- ✅ 노트 트리 (parent-child, indent guide lines)
- ✅ Wikilink (autocomplete palette, broken-link decoration, live label sync)
- ✅ Archive UX (confirm dialog, popover, sidebar-width tracking)
- ✅ ⌘K 통합 Command Palette (Actions: Archive active note)
- ✅ 3-pane 레이아웃 스크롤 격리 (shadcn sidebar.tsx 소스 수정)

### Theme / UI 폴리싱
- ✅ Luma neutral preset + semantic tokens (z-index, state)
- ✅ Radix-luma UI primitives 6종
- ✅ Geist 타이포그래피, 통일된 헤더 높이

---

## 미커밋 상태

```
M apps/writer-tauri/src/components/ui/sidebar.tsx
M apps/writer-tauri/src/layout/AppShell.tsx
```

shadcn-friendly 레이아웃 수정 (SidebarProvider `min-h-svh` → `h-svh overflow-hidden`).
→ 다음 작업 시작 전 커밋 푸시 권장.

---

## 다음 후보 (우선순위 순)

### 🔴 1순위 — 즉시 마무리 (≈30m)

**1-A. 미커밋 변경 커밋 푸시**
- shadcn sidebar 소스 수정 1건. PR/커밋 1개.

**1-B. 채팅 reliability 마감 (Phase 5 Step 7 잔여)**
- 네트워크 / rate limit / OAuth 만료 에러 메시지 분기
- 매우 긴 문서 truncation 경고
- 빈 user 메시지 / 연속 전송 방지

**1-C. 디자인 폴리싱 (Task #40, #47)**
- 슬래시 커맨드 UX polish (icons, spacing, code preview)

### 🟡 2순위 — 마크 인터랙션 보완 (M6 잔여, ≈1d)

**2-A. Bulk Actions** (roadmap PR1-B)
- `acceptAllMarks(view)` / `rejectAllMarks(view)`
- 헤더 카운터 chip + ⇧⌘A / ⇧⌘R
- 0개일 때 자동 숨김 — 현재 "Reviewing…" 배지 자리에 통합 가능

**2-B. 호버 액션 바** (roadmap PR3)
- 마크 위 호버 시 부유 [✓][✕] 버튼
- React Portal + view.coordsAtPos
- 키보드 못 쓰는 사용자용

### 🟢 3순위 — Comment 마크 (≈2d)

**3-A. proofComment schema + 플러그인**
- 옅은 노란색 decoration
- Y.Map('marks') 의 comment 종류 인식

**3-B. 코멘트 UI**
- 호버 popover 에 텍스트
- 텍스트 선택 → 단축키로 코멘트 추가
- resolve / 답글 (단순)

### 🟢 4순위 — Wiki 가시성 (note-product-design Q12 PR F, ≈1d)

- 사이드바 Wiki 섹션 (현재 Notes/Daily만 보임)
- belief 노트 클릭 → 메인 에디터 (writing과 동일 흐름)
- WikiView 연결 (현재 `views/WikiView.tsx` 미연결 추정)

### 🔵 5순위 — Reliability 후속 (Post-M8)

본 문서 하단 "Post-M8" 섹션 그대로 유지. 토스트 / 텔레메트리 / 자동 복구.

### 🔵 6순위 — 백업 + 라이프사이클 (note-product-design Q4, Q6)

- 마크다운 git 자동 백업 (5분 idle, 디바운스)
- Archive 30일 자동 hard delete
- Cascade delete confirm dialog (자식 N개)

### 🔵 7순위 — Author stats (proofAuthored, roadmap PR4)

- 사람/AI 글자 비중 사이드 패널
- proofAuthored 마크 글자 수 집계
- 시각화 토글

### 🟣 미정 — M8 Cutover

- DMG 빌드 + 코드 사이닝 + 공증
- Tauri auto-updater
- 베타 5–10명 배포
- 1주 모니터링 → `apps/writer/` archive (※ 이미 Electron 앱은 retired됨, 코드 정리만 남음)

---

## Post-M8 — proof-sdk 비교에서 빠진 안전망 (참조용 유지)

### Post-M8.1 — 작업 단위 try/catch 강화 (~1h)
- `markActions.acceptMark/rejectMark/jumpToMark` — silent return 대신 로그 + 토스트
- `runChat` / 슬래시 커맨드 실패 시 사용자 가시 메시지

### Post-M8.2 — 토스트 시스템 (~1.5h)
- `sonner` (shadcn 호환)
- Claude 연결 / AI 검토 완료 / 마크 액션 / 네트워크

### Post-M8.3 — 자동 복구 (~2h)
- mark 액션 실패 시 → 서버 상태 refetch → Y.Doc 동기화
- 단일 사용자 단계는 우선 낮음

### Post-M8.4 — 텔레메트리 (~1h)
- `captureEvent(name, props)` no-op 헬퍼
- 핵심 이벤트만, 출시 전 Sentry hook

---

## 결정 안 한 것

- 채팅 토큰 사용량 표시 (usage 데이터는 보존됨)
- 멀티 디바이스 (proof-sdk 서버 원격화) — note-product-design Q4 deferred
- Memory-writer 정식 (P3) — 위키 자동 갱신 흐름

---

## 시작할 때 체크리스트

- [ ] 1-A 커밋 푸시
- [ ] 1-B 채팅 reliability
- [ ] 1-C 디자인 폴리싱
- [ ] 2-A Bulk Actions
- [ ] 2-B 호버 액션 바
- [ ] 3 Comment 마크
- [ ] 4 Wiki 사이드바 섹션
