# ADR: Electron → Tauri 전환

작성: 2026-04-30
상태: **Accepted**

---

## Context

현재 `apps/writer`는 Electron으로 구축됨. 다음 이유로 재검토:

1. **현재 통합 복잡도**: proof-sdk 통합 과정에서 main/preload/renderer 분리, IPC, proof-server lifecycle 관리 등이 누적된 우회 코드를 만들어냄. 디버깅 시 module 중복, 좀비 프로세스, HMR state corruption 등의 이슈 반복.

2. **제품 비전과의 정합**: 다중 에이전트 + 개인 wiki LLM이 핵심. 미래에 로컬 LLM 통합(candle, mistral-rs 등) 가능성 큼. Rust 생태계가 이 영역에서 빠르게 성장 중.

3. **인디 데스크톱 앱 정체성**: 사용자가 매일 여는 노트 앱은 가벼워야 함. Electron의 300MB 번들 / 400MB idle 메모리는 이 정체성과 미스매치.

## 검토한 옵션

### Option A: Electron 유지
- 친숙함, 풍부한 npm 생태계
- 단점: 무거움, 현재 누적된 복잡도 그대로

### Option B: 웹앱 전환
- 가장 단순. proof-sdk 본가 패턴
- 단점: 노트 데이터 로컬 저장 안 됨, 미래 로컬 LLM 통합 어려움

### Option C: Tauri (Rust + 시스템 webview)
- 번들 10-20MB / idle 100-150MB
- Rust backend → 미래 로컬 LLM 네이티브 통합 유리
- React/Tailwind 그대로 사용 가능
- 단점: Rust 학습 곡선 (~2주), 시스템 webview 차이 (macOS WebKit vs Chromium)

## Decision

**Option C — Tauri**.

근거:
- 데스크톱 앱 결정 (사용자 노트 로컬 저장 + 미래 로컬 LLM)
- 인디 정체성: 가벼움 우선
- 미래 로컬 LLM 통합 시 Rust 직접 통합이 Node FFI/sidecar 대비 유리
- 0부터 다시 시작할 의사 있음 → 마이그레이션 비용 감수 가능
- 현재 Electron 코드의 약 30%(React 컴포넌트, 디자인 시스템)는 그대로 재활용

## Consequences

### Positive
- 번들/메모리 ~3-10배 개선
- main process 라이프사이클 단순화 (Rust async)
- Tauri의 sidecar 패턴으로 proof-server spawn 안정화
- 보안 모델 기본값이 더 안전 (allowlist 기반)
- 미래 로컬 LLM 통합 path 명확

### Negative
- Rust 학습 비용 (2-3주 friction)
- 시스템 webview 차이로 OS별 미세 동작 검증 필요
- 생태계 작아 일부 기능은 직접 Rust로 구현 필요
- 현재 Electron 코드 70% 폐기

### Mitigations
- 현 `apps/writer/`는 참조용으로 유지, 새 `apps/writer-tauri/` 병행
- React 컴포넌트, 디자인 토큰, hooks 100% 재활용
- Phase별 점진적 포팅 (셸 → proof-server 통합 → 에디터 → 에이전트)

## Related

- `docs/adr/2026-04-30-path-b-rewrite.md` (에디터 Path B 결정 — 동시 진행)
- `docs/archive/path-b-rewrite-plan.md` (실행 계획)
