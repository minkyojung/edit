# ADR: 에디터를 Milkdown으로 직접 구축 (Path B)

작성: 2026-04-30
상태: **Accepted**

---

## Context

현재 `MilkdownEditor.tsx`는 `proof-sdk/src/editor/index.js`의 `ProofEditorImpl`을 import해서 React에 mount하는 방식. 통합 과정에서 다음 문제들이 누적:

1. **proof-sdk의 의도된 사용 모델과 불일치**
   - proof-sdk의 example app(`apps/proof-example`)은 editor를 import하지 않고 HTTP bridge만 사용
   - 공식 SKILL 문서: "Prefer HTTP APIs over local runtime assumptions"
   - 즉 editor는 standalone web app으로 실행되고, 외부 통합은 HTTP로만 한다는 가정
   - 우리는 ProofEditorImpl을 React에 직접 embed 하고 내부 collab service를 우리 ydoc으로 교체 — proof-sdk가 가정하지 않은 사용 방식

2. **반복되는 통합 충돌**
   - milkdown listener가 y-prosemirror의 `addToHistory:false` 때문에 죽는 문제 → `view.dispatch` monkey-patch로 우회
   - prosemirror-model 인스턴스 중복 가능성으로 인한 `localsInner`/`eq` undefined 에러
   - mark hydration 실패 시 2분 TTL로 인한 "되었다 안되었다" 패턴
   - 모든 우회 코드가 proof-sdk 업데이트 시 깨질 위험

3. **제품 디자인 자유도 제약**
   - editor 내부의 mark popover, 모바일 strip, 코멘트 thread는 proof-sdk가 그림
   - 본인 제품은 완전히 다른 UX/디자인을 원함 → proof-sdk UI 그대로 못 씀

## 검토한 옵션

### Option A: ProofEditorImpl 통째 임베드 + 내부 우회 (현재 상태)
- 모든 기능 즉시 사용 가능
- 단점: 위 모든 충돌 지속, 디자인 자유도 0

### Option B: HTTP bridge로만 사용 + editor는 BrowserView/iframe
- proof-sdk가 의도한 사용 방식
- 단점: 별도 process로 실행되어 React UI와의 통합 어려움, editor 디자인은 proof-sdk 거 그대로

### Option C: Editor 직접 구축 (Milkdown) + proof-sdk는 server + format spec만 사용
- 디자인/UX 100% 자유
- 모든 module 충돌 사라짐
- proof-sdk의 핵심 인프라(server, format spec, bridge protocol)는 그대로 활용
- 단점: editor 본체와 mark hydration을 직접 구현 (~500줄)

## Decision

**Option C — Path B (선택적 포팅)**.

가져옴:
- proof-server (HTTP API, 영속성, CRDT, edit/v2, mark rehydration 알고리즘)
- Mark format spec (`{ id, kind, by, quote, range, ... }` JSON 형태)
- Bridge HTTP 프로토콜 (mutation base, idempotency 패턴)

직접 구현:
- Milkdown 에디터 본체 (proof-sdk editor 안 import)
- ProseMirror mark schema
- 클라이언트 사이드 mark hydration (range + quote + relative offset 3중 anchor)
- 마크 인터랙션 UX (accept/reject UI 우리 React로)
- 다중 에이전트 오케스트레이션
- Wiki LLM 통합

## Consequences

### Positive
- 디자인/UX 100% 자유
- proof-sdk 내부 동작과 우리 코드 완전 분리 → 통합 충돌 사라짐
- proof-sdk 업데이트 흡수 안전 (HTTP API만 의존)
- 다중 에이전트 + wiki LLM이라는 본인 제품의 진짜 차별점에 집중
- 우리 환경에 최적화된 hydration 알고리즘 가능

### Negative
- proof-sdk의 25개 plugin (mermaid, agent presence, heatmap 등) 자동으로 못 받음
- mark hydration 알고리즘 직접 구현 (~300줄)
- Schema/format 변경 시 proof-sdk와의 호환 직접 관리

### Mitigations
- proof-sdk fork에서 mark format spec과 hydration 알고리즘은 학습 자료로 활용
- 우리 mark schema는 proof-sdk와 JSON 호환 유지 → proof-server와 그대로 통신 가능
- 필요한 plugin은 나중에 하나씩 직접 구현 (mermaid, agent presence 등)

## Related

- `docs/adr/2026-04-30-tauri-over-electron.md` (Tauri 전환 결정 — 동시 진행)
- `docs/archive/proof-sdk-integration-notes.md` (현재 통합에서 배운 점)
- `docs/archive/proof-sdk-integration-plan.md` (이전 Path A 계획 — 참조용으로 보존)
- `docs/archive/path-b-rewrite-plan.md` (실행 계획)
