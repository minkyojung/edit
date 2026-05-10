# Path B + Tauri 재구축 실행 계획

작성: 2026-04-30
상태: Draft (실행 시작 전 검토 필요)
관련 ADR:
- `docs/adr/2026-04-30-path-b-rewrite.md` — 에디터 직접 구축
- `docs/adr/2026-04-30-tauri-over-electron.md` — 셸 전환

---

## 0. 이 문서의 역할

두 ADR이 결정한 두 가지 큰 변화를 **하나의 실행 트랙**으로 묶어, 단계별 완료 기준과 체크리스트를 박아두는 문서. Reliability(에러 0, well-made) 원칙상 각 단계 완료 기준을 충족하지 못하면 다음 단계로 넘어가지 않는다.

핵심 계약 (전 단계 공통):
- `apps/writer/`(Electron)는 **freeze**. 참조용으로만 유지하고 기능 추가 금지.
- `apps/writer-tauri/`를 신설해 단계별로 진화시킨다.
- proof-sdk와는 **HTTP API + JSON mark format**으로만 결합. 어떤 단계에서도 proof-sdk 내부 모듈을 import 하지 않는다.
- 각 단계는 검증 가능한 **완료 기준**을 가진다. 통과 못 하면 멈춘다.

---

## 1. 현재 상태 스냅샷 (2026-04-30)

### 1.1 코드 구조

```
apps/writer/                      ← Electron, 동결 대상
├── src/main/                     ← Node main process
│   ├── agentService.ts           Copyeditor 에이전트 (claude-agent-sdk)
│   ├── agentSessionStore.ts      세션 영속
│   ├── agentSettings.ts
│   ├── chatService.ts
│   ├── claudeRuntime.ts
│   ├── docService.ts             proof-sdk 문서 lifecycle
│   ├── markService.ts            마크 CRUD
│   ├── memoryService.ts          위키 belief 관리
│   ├── oauthService.ts           Sign in with Claude (PKCE)
│   ├── proofClient.ts            proof-server HTTP 클라이언트
│   ├── wikiService.ts            위키 부트스트랩
│   └── index.ts                  앱 엔트리, IPC 핸들러
├── src/preload/index.ts          contextBridge
└── src/renderer/src/
    ├── App.tsx
    ├── MilkdownEditor.tsx        ← ProofEditorImpl import (Path B에서 재작성)
    ├── components/               account-menu, sign-in-panel, wiki-modal, ui/
    ├── layout/                   AppShell, Sidebar, ContextPanel
    ├── hooks/                    useIdleCallback, use-mobile
    ├── state/                    layoutStore (zustand)
    └── lib/utils.ts
```

### 1.2 재활용 가능 자산 (writer-tauri로 그대로 이동)

| 자산 | 이동 비용 | 비고 |
|---|---|---|
| `components/ui/`(shadcn) | 0 | 그대로 복사 |
| `components/account-menu`, `sign-in-panel`, `wiki-modal` | 낮음 | IPC 호출부만 Tauri command로 교체 |
| `layout/`(AppShell, Sidebar, ContextPanel) | 0 | renderer 순수 React |
| `hooks/`, `lib/utils.ts`, `state/layoutStore.ts` | 0 | |
| 디자인 토큰, Tailwind 설정, `index.css` | 0 | |
| `oauthService.ts` PKCE 흐름 | 중간 | Rust로 포팅 또는 sidecar |
| HTTP 클라이언트(`proofClient.ts`) 호출 시그니처 | 중간 | renderer fetch로 직접 부르거나 Tauri command로 래핑 |

### 1.3 폐기 대상

- `MilkdownEditor.tsx` 전체 (ProofEditorImpl embed 방식)
- main process IPC 코드 (Tauri command로 대체)
- preload (Tauri는 contextBridge 불필요)
- electron.vite.config.ts 등 Electron 빌드 인프라

---

## 2. 마일스톤 개요

| # | 마일스톤 | 기간(추정) | 완료 기준 한 줄 |
|---|---|---|---|
| M0 | 계획 확정 + 레포 분리 | 0.5d | 본 문서 Accepted, 새 앱 디렉터리 시드 |
| M1 | Tauri 빈 셸 | 5d | 라우팅·레이아웃이 동작, 에디터 영역은 placeholder |
| M2 | proof-server sidecar | 4d | sidecar로 spawn된 proof-server에 HTTP round-trip 성공 |
| M3 | Milkdown 기본 에디터 (스탠드얼론) | 7d | proof-sdk 없이 텍스트 입력/저장/리로드가 동작 |
| M4 | Yjs ↔ proof-server collab | 5d | 두 창에서 실시간 동기화, 새로고침 후 복원 |
| M5 | Mark format + hydration | 7d | range+quote+offset 3중 anchor로 마크 복원, 누락 시 graceful |
| M6 | 마크 인터랙션 UX | 4d | suggestion accept/reject (Tab/Esc + 단일/Bulk), 작성자 추적 |
| M7 | OAuth + 에이전트 포팅 | 7d | Copyeditor가 새 셸에서 suggestion 생성, P1 동등성 |
| M8 | Cutover | 2d | 베타 사용자에게 새 빌드 배포, 구앱은 archive |

총 8-9주 예상. 각 마일스톤은 **PR 1개 이상**으로 나눠 머지한다.

---

## 3. 마일스톤별 상세

### M0 — 계획 확정 + 레포 분리 (0.5일)

**목표**: 실행에 필요한 골격만 만들고 합의 확정.

체크리스트:
- [ ] 본 문서 검토 → Accepted 상태로 변경
- [ ] `apps/writer/`에 `FROZEN.md` 추가 (PR 머지 정책 명시)
- [ ] `apps/writer-tauri/` 빈 디렉터리 생성, `pnpm-workspace.yaml` 등록
- [ ] Rust toolchain 설치 검증 (`rustc --version`, `cargo --version`)
- [ ] Tauri CLI(`@tauri-apps/cli`) 버전 결정 (v2 권장)

완료 기준:
- `pnpm -r ls`에 `writer-tauri` workspace 노출
- Rust/Tauri 빌드 환경이 macOS 로컬에서 검증됨

---

### M1 — Tauri 빈 셸 (5일)

**목표**: React + Tailwind + 디자인 시스템이 Tauri 안에서 그대로 살아 있는 상태. 비즈니스 로직 0.

체크리스트:
- [ ] `pnpm create tauri-app` 또는 수동 셋업 (Vite + React + TS)
- [ ] Tailwind 설정 + 디자인 토큰 import
- [ ] shadcn 셋업 (`components.json` 복사)
- [ ] `src-tauri/tauri.conf.json` — 윈도우 크기, title, identifier
- [ ] `apps/writer/src/renderer/src/components/ui/` → 그대로 복사
- [ ] `layout/`(AppShell, Sidebar, ContextPanel) 복사
- [ ] `state/layoutStore.ts`, `hooks/`, `lib/utils.ts` 복사
- [ ] 라우팅(필요 시 react-router) — 단일 화면이면 생략
- [ ] 에디터 영역에 `<EditorPlaceholder />` (회색 박스)
- [ ] dev 빌드 + prod 빌드 검증 (DMG 생성 확인)

완료 기준:
- `pnpm tauri dev` 실행 → 사이드바/레이아웃이 구앱과 시각적으로 동일
- 번들 크기 측정 → ADR 예측치(10-20MB) 범위 안
- idle 메모리 측정 → 100-200MB 범위 안

리스크/주의:
- Tauri v2 vs v1 — v2 default. plugin API 호환성 확인.
- macOS WebKit과 Chromium 차이로 일부 CSS(`backdrop-filter` 등) 검증 필요.

---

### M2 — proof-server sidecar (4일)

**목표**: proof-server를 Tauri sidecar로 안정적으로 spawn/lifecycle 관리하고, renderer에서 HTTP round-trip 성공.

체크리스트:
- [ ] proof-server 바이너리 빌드 산출물 위치 결정 (fork에서 어떻게 가져올지)
- [ ] `tauri-plugin-shell` 또는 직접 sidecar 구성 — `tauri.conf.json` `bundle.externalBin`
- [ ] Rust 측 `setup` 훅에서 sidecar spawn, 종료 시 kill
- [ ] 포트 충돌 회피 전략 — 0번 포트 → OS가 할당한 포트를 renderer로 전달 (Tauri event)
- [ ] Health check (GET `/health`) 폴링 후 ready 이벤트 emit
- [ ] renderer: `proofClient.ts` 포팅 (Node 의존 제거, `fetch` 사용)
- [ ] 좀비 프로세스 방지 — Tauri window close → sidecar SIGTERM → 5초 후 SIGKILL
- [ ] dev/prod 둘 다에서 sidecar 경로 해석 검증

완료 기준:
- 앱 시작 5초 안에 proof-server ready
- 문서 생성/조회 HTTP가 renderer에서 성공
- 앱 종료 후 `ps aux | grep proof` 에 좀비 없음
- 강제 종료(Cmd+Q) 후 재시작에도 sidecar 정상 spawn

리스크/주의:
- proof-server가 Node 런타임 필요하면 Node도 sidecar로 같이 번들 → 크기 ↑.
- 단일 바이너리(pkg/Bun compile) 가능 여부 사전 검증 권장.

---

### M3 — Milkdown 기본 에디터 (스탠드얼론) (7일)

**목표**: proof-sdk 없이도 동작하는 Milkdown 에디터. 텍스트 입력 → 로컬 상태 → 새로고침해도 살아 있음.

체크리스트:
- [ ] `apps/writer-tauri/src/editor/` 디렉터리 신설
- [ ] Milkdown core, preset-commonmark, preset-gfm 설치
- [ ] `<MilkdownEditor />` 컴포넌트 from-scratch (ProofEditorImpl import 금지)
- [ ] ProseMirror schema 정의 — 우리 mark schema 포함될 자리만 비워둠
- [ ] 키보드 단축키 (bold, italic, heading) 동작
- [ ] 로컬 markdown 저장 (Tauri `fs` plugin) — proof-server 없이도 동작 가능해야 함
- [ ] 에디터 unmount 시 누수 없는지 검증 (devtool memory profile)

완료 기준:
- 텍스트 입력/편집/저장/리로드 동작
- proof-sdk 패키지 import 0 (검증: `grep -r "proof-sdk\|@proofsdk" src/editor/`)
- 새로고침 후 컨텐츠 복원

리스크/주의:
- prosemirror-model 인스턴스 중복 문제는 단일 진입점에서 schema를 만들면 자연 해결.
- Milkdown plugin API와 직접 ProseMirror plugin API 혼용 시 우선순위 명시.

---

### M4 — Yjs ↔ proof-server collab (5일)

**목표**: 두 창을 띄우면 실시간 동기화되고, 새로고침 후에도 컨텐츠가 살아 있음.

체크리스트:
- [ ] Yjs + y-prosemirror 통합 (Milkdown collab plugin 또는 직접)
- [ ] HocuspocusProvider로 proof-server WebSocket 연결
- [ ] 문서 ID = proof-server doc ID, 라우팅으로 결정
- [ ] 연결 상태 UI (connecting / connected / offline) — 토큰: `<ConnectionPill />`
- [ ] 오프라인 편집 → 재연결 시 머지 검증
- [ ] `addToHistory:false` 이슈가 우리 코드에서 재발 안 함을 확인 (monkey-patch 없이)

완료 기준:
- 두 창에서 동일 문서 편집 → 실시간 반영 (latency < 200ms 로컬)
- 새로고침 후 컨텐츠 100% 복원
- 5분 idle 후에도 연결 유지 또는 자동 재연결
- 네트워크 끊김(sidecar kill) → 재시작 시 상태 머지

리스크/주의:
- y-prosemirror의 history 처리는 Path B 결정의 핵심 동기 중 하나. 우회 코드가 다시 필요해지면 schema/plugin 설계로 흡수해야 한다.

---

### M5 — Mark format + hydration (7일)

**목표**: proof-sdk와 JSON 호환되는 mark schema, 그리고 안정적인 hydration. "되었다 안되었다" 패턴 박멸.

체크리스트:

**Schema**:
- [ ] `MarkV1` 타입 정의 — `{ id, kind, by, quote, range:{from,to}, offset, createdAt, ... }`
- [ ] proof-server의 마크 JSON과 round-trip 일치 검증 (snapshot test)
- [ ] ProseMirror mark spec 정의 (`proofSuggestion`, `proofComment`, `proofAuthored`)

**Hydration (3중 anchor)**:
- [ ] Primary: `range.from/to` 직접 매핑
- [ ] Fallback 1: `quote` 텍스트 매칭 (Levenshtein < 임계)
- [ ] Fallback 2: `offset` 상대 위치
- [ ] 모두 실패 시: 마크를 "orphan"으로 보관, UI에서 사이드 패널 표시 (소실 금지)
- [ ] hydration은 idempotent — 같은 마크 두 번 적용 시 중복 안 됨
- [ ] tombstone(삭제 마크)도 hydration 대상

**작성자 추적 (`proofAuthored`)**:
- [ ] 사용자/AI 자동 마킹 (input source 구분)
- [ ] 시각화 토글 (디버그 모드)

테스트:
- [ ] 단위 테스트: 100개 mark fixture로 hydration 성공률 측정 (목표 > 99%)
- [ ] 통합 테스트: edit → reload → mark 위치 동일

완료 기준:
- TTL 우회 코드 없음
- 1000자 문서 + 50개 마크에서 hydration < 50ms
- orphan 마크가 사용자에게 가시화됨

---

### M6 — 마크 인터랙션 UX (4일)

**목표**: 사용자가 suggestion을 받아들이고 거절하는 흐름이 새 셸에서 동등하게 동작.

체크리스트:
- [ ] suggestion 마크 인라인 decoration (색상, 밑줄)
- [ ] 키보드: Tab(accept) / Esc(reject) / 자동 다음 마크 이동
- [ ] 마우스 호버 액션 바 (roadmap PR3) — `view.coordsAtPos` + React Portal
- [ ] Bulk Actions (roadmap PR1-B) — 카운터 칩 + ⇧⌘A / ⇧⌘R
- [ ] 단어 경계 정렬 (Intl.Segmenter)
- [ ] tombstone 일괄 추가 + API 호출
- [ ] 모든 인터랙션이 우리 React 컴포넌트로 그려짐 (proof-sdk popover 제거 확인)

완료 기준:
- 구앱과 키보드/마우스 인터랙션 1:1 동등
- proof-sdk UI 컴포넌트 import 0

---

### M7 — OAuth + 에이전트 포팅 (7일)

**목표**: P1 동등성 — 글 쓰고 1.5초 멈추면 Copyeditor suggestion이 사이드바에 표시.

체크리스트:

**OAuth**:
- [ ] `oauthService.ts` 흐름을 Rust(`tauri-plugin-oauth`) 또는 Node sidecar로 포팅
- [ ] PKCE flow + 시스템 브라우저 redirect
- [ ] 토큰 저장 — Tauri `stronghold` 또는 OS keychain
- [ ] AccountIndicator/SignInPanel 동작

**에이전트**:
- [ ] `claude-agent-sdk` 사용 위치 결정 — Node sidecar 권장 (Rust 포팅은 비용 높음)
- [ ] sidecar ↔ renderer 통신 채널 (Tauri event 또는 IPC over HTTP)
- [ ] `agentService.ts`, `agentSessionStore.ts`, `agentSettings.ts` 포팅
- [ ] `wikiService.ts`, `memoryService.ts` 포팅
- [ ] `chatService.ts` 포팅
- [ ] idle 1.5초 트리거 (`useIdleCallback`) 재연결
- [ ] 위키 belief를 system prompt에 주입 (latency 경로)
- [ ] session_id 영구 저장 + resume (plan.md P2-A 잔여)
- [ ] `autoCompactEnabled: true` 명시
- [ ] `effort: 'low'` 추가

완료 기준:
- 글 쓰고 1.5초 멈춤 → suggestion 마크 인라인 렌더
- TTFT < 1초 (위키 캐시 hit 후)
- OAuth 사인인 → 계정 인디케이터 표시
- 위키 변경 → 세션 재시작 → 새 belief 반영

---

### M8 — Cutover (2일)

**목표**: 베타 사용자가 새 빌드를 받고, 구앱은 archive.

체크리스트:
- [ ] DMG 빌드 + 코드 사이닝 + 공증 (notarization)
- [ ] auto-updater 결정 (Tauri updater plugin)
- [ ] 베타 5-10명에게 빌드 배포
- [ ] 1주 모니터링 — quota 사용량, 충돌 리포트, 메모리 누수
- [ ] 통과 시 `apps/writer/` → `apps/writer-electron-archive/`로 이동, README에 archive 명시
- [ ] CI에서 archive 빌드는 제외

완료 기준:
- 베타 사용자가 1주간 일일 사용에서 충돌 0
- 메모리/CPU 회귀 없음 (구앱 대비 같거나 좋음)

---

## 4. PR 분할 가이드

마일스톤은 보통 2-4개 PR로 쪼갠다. PR 단위 원칙:
- 항상 머지 후에도 **앱이 동작 가능**해야 함 (broken 상태로 머지 금지)
- 각 PR은 자체 완료 기준과 테스트를 포함
- M3-M5는 단계가 미세해 PR이 더 잘게 쪼개질 수 있음 (예: schema PR → primary hydration PR → fallback PR)

브랜치 네이밍: `minkyojung/<짧은-주제>` (30자 이내).

---

## 5. 검증 전략

### 5.1 단위 테스트 (필수 영역)

- Mark schema round-trip (proof-server JSON ↔ MarkV1)
- Hydration 알고리즘 (3중 anchor fixture)
- 단어 경계 정렬

### 5.2 통합 테스트

- Tauri sidecar lifecycle (spawn/kill/zombie)
- Yjs collab 두 창 동기화
- OAuth flow end-to-end (mock IdP)

### 5.3 수동 검증 시나리오 (각 마일스톤 완료 시 실행)

1. 빈 문서에 1000자 입력 → 새로고침 → 100% 복원
2. Suggestion 50개 받고 모두 수락/거절 → 토큰 정렬 정상
3. 5분 idle 후 다시 입력 → 세션 resume 동작
4. 네트워크 끊고 편집 → 재연결 시 머지

---

## 6. 리스크 레지스터

| # | 리스크 | 영향 | 대응 |
|---|---|---|---|
| R1 | macOS WebKit과 Chromium 차이 | 중 | M1에서 디자인 토큰 + 핵심 인터랙션 검증, 차이 발견 시 polyfill 또는 디자인 조정 |
| R2 | proof-server를 sidecar로 안정화 어려움 | 상 | M2를 별도 마일스톤으로 격리, 좀비 방지 테스트 명시 |
| R3 | claude-agent-sdk Node 의존 → Rust 포팅 비용 | 상 | Node를 sidecar로 받아들이는 결정을 M7 시작 시 명시. 단일 바이너리(pkg) 검토 |
| R4 | Yjs/y-prosemirror history 이슈 재발 | 중 | M4 완료 기준에 monkey-patch 없음 명시, 발생 시 schema 재설계로 흡수 |
| R5 | 8-9주 일정 지연 | 중 | 각 마일스톤에 buffer 없음. 지연 시 M7(에이전트 포팅) 범위를 P1 동등성으로만 한정하고 P2-A 잔여는 다음 사이클로 |
| R6 | Rust 학습 곡선 | 중 | M0-M2를 Rust 노출 최소로 설계 (Tauri command 몇 개), 본격 학습은 M7 OAuth/sidecar에서 |

---

## 7. 비목표 (Out of scope)

이 계획은 다음을 포함하지 않는다 — 새 셸이 P1 동등성을 회복한 **뒤** 별도 사이클로 다룬다:

- P3 (Memory-writer 정식, Gmail/캘린더 연동)
- P4 (멀티 에이전트, Fact-checker, Voice-mimic, Harness 추상화)
- proof-sdk plugin 자체 구현 (mermaid, agent presence, heatmap 등)
- 모바일 빌드

---

## 8. 진척 추적

- 2026-04-30 M0 Accepted — 본 문서 합의, writer-tauri workspace 시드
- 2026-04-30 M1 완료 — Tauri 빈 셸 + shadcn 이식
- 2026-04-30 M2 완료 — proof-server sidecar (Rust `SidecarClient::spawn_initialized`, dev/prod 경로 자동)
- 2026-04-30 M3 완료 — Milkdown 기본 에디터 (스탠드얼론)
- 2026-04-30 M4 완료 — Yjs ↔ proof-server collab (HocuspocusProvider)
- 2026-05-01 M5 완료 — 마크 스키마 + hydration, 단일 앵커 통일, cleanup plugin
- 2026-05-01 M6 부분 완료 — 마크 popover accept/reject ✅, Bulk Actions ✗, hover bar ✗
- 2026-05-02 M7 완료 — Claude OAuth (PKCE + 암호화 keychain) + Anthropic SDK via Rust proxy + Copyeditor (`/proofread`)
- 2026-05-04 — 슬래시 커맨드 프레임워크 (chat-message / document-edit / review-comments kinds), `/outline /polish /shorten /expand /review`
- 2026-05-05 — 멀티 문서 탭, 일별 노트 트리 (Mon-anchored, 7-day backfill), Wikilink (autocomplete + broken-link deco), Archive UX
- 2026-05-06 — 레이아웃: 3-pane 스크롤 격리 (shadcn `sidebar.tsx` 소스 수정), 트리 가이드라인, ⌘K Archive action
- M8 Cutover — 미실행 (베타 배포 + 코드 사이닝 단계 남음)

---

## 9. 관련 문서

- `docs/adr/2026-04-30-path-b-rewrite.md`
- `docs/adr/2026-04-30-tauri-over-electron.md`
- `docs/plan.md` — 제품 전체 계획 (L1-L5 아키텍처, P1-P4 phase)
- `docs/roadmap.md` — UI/기능 PR 단위 (M6 Bulk Actions 등 참조)
- `docs/archive/` — 이전 Path A 계획 (참조용)
