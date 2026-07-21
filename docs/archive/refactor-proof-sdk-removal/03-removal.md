# Phase 3 — proof-sdk / proof-server 제거

**기간**: 4일
**선행**: Phase 2 완료 (`proofClient.ops` 호출 0건 확인)
**목적**: proof-server 사이드카 + `@proof-sdk/*` 의존 + 관련 파일/설정 모두 제거. 부팅 시 사이드카 spawn 안 됨.

## 사전 결정 — 협업 (Hocuspocus) 어떻게 할지

proof-server 는 두 역할을 동시에 함:
1. Mark mutation `/ops` HTTP API (Phase 2 에서 우회 완료)
2. **Hocuspocus WebSocket 서버** — 멀티 디바이스 Y.Doc 동기화

`@hocuspocus/provider` 를 우리 클라이언트는 계속 씀 (`useCollabDoc.ts:60` 의 `CollabHandle.provider`). 서버를 누가 띄울 것인가?

### 옵션 3A — Hocuspocus 자체 서버 구동 (별도 작은 Node 서버)
- pros: 멀티 디바이스 동기화 유지
- cons: 새 서버 코드 + 배포 인프라 필요

### 옵션 3B — 단일 기기 IDB-only 모드 (provider 제거)
- pros: 서버 0, 가장 단순
- cons: 멀티 디바이스 동기화 잃음 (모바일↔노트북)

### 권장: 3B 로 시작, 필요해질 때 3A 추가

이유:
- 현재 유저 0, 단일 기기 사용 가정
- IDB 만으로 90% 사용 시나리오 커버
- 추후 멀티 디바이스 욕구 강해지면 그때 작은 Hocuspocus 서버 추가 (1~2주)

이 문서는 **3B 기준**으로 작성. 3A 가 결정되면 별도 mini-phase 추가.

## 제거 대상 파일

### 코드 (전체 삭제)
- [ ] `apps/writer-tauri/src/lib/proofClient.ts` — HTTP 클라이언트
- [ ] `apps/writer-tauri/src/types/proof-sdk.d.ts` — TS shim
- [ ] `apps/writer-tauri/src/components/EngineGate.tsx` — proof-server health gate

### 코드 (부분 수정)
- [ ] `apps/writer-tauri/src/editor/proofMarks.ts` — proof-sdk import 제거, 마크 schema 를 우리 코드로 가져옴 (아래 "마크 schema 이식" 참조)
- [ ] `apps/writer-tauri/vite.config.ts` — `@proof-sdk` alias 제거
- [ ] `apps/writer-tauri/src-tauri/src/lib.rs` — `spawn_proof_server`, `shutdown_proof_server`, `check_proof_server_health`, `respawn_proof_server`, `ProofServerPgid` 모두 제거 (lib.rs:41~190 부근 + invoke_handler 등록 제거)

### 의존 (`package.json`)
- [ ] `@proof-sdk/editor`
- [ ] `@proof-sdk/server` (있다면)
- [ ] `@proof-sdk/types` (있다면)

### 바이너리
- [ ] `apps/writer-tauri/src-tauri/binaries/proof-server-aarch64-apple-darwin`
- [ ] `apps/writer-tauri/src-tauri/binaries/proof-server-aarch64-apple-darwin.bun-version`
- [ ] `apps/writer-tauri/src-tauri/binaries/bun-aarch64-apple-darwin` (proof-server 가 bun 으로 실행되니 같이)
- [ ] `apps/writer-tauri/src-tauri/binaries/bun-aarch64-apple-darwin.version`
- [ ] `apps/writer-tauri/scripts/setup-binaries.sh` — proof-server 다운로드 부분 제거 (bun 부분도 필요 없으면 같이)

### Hocuspocus provider 제거 (3B 옵션)
- [ ] `apps/writer-tauri/src/state/docsStore.ts` — `HocuspocusProvider` 생성 부분 제거. `CollabHandle.provider` → null 고정 또는 타입에서 제거
- [ ] `apps/writer-tauri/src/hooks/useCollabDoc.ts` — `CollabHandle.provider: HocuspocusProvider | null` → 제거
- [ ] `apps/writer-tauri/src/editor/MilkdownEditor.tsx:340` — `if (provider?.awareness) service.setAwareness(provider.awareness)` 부분 제거
- [ ] `package.json` 에서 `@hocuspocus/provider` 제거

## 마크 schema 이식

### 현재
`proofMarks.ts` 가 `@proof-sdk/editor/schema/proof-marks` 에서 import.

### 새 위치
`apps/writer-tauri/src/editor/schema/proofMarks.ts` (또는 `domain/schema/`)

### 어떻게
proof-sdk 의 마크 schema 코드를 그대로 가져옴 (Phase 0 에서 결정한 3개 종류만):

```ts
import { $markSchema } from '@milkdown/kit/utils'

export const proofSuggestion = $markSchema('proofSuggestion', () => ({
  attrs: {
    id: { default: null },
    kind: { default: 'suggestion' },
    suggestionType: { default: 'replace' },
    quote: { default: '' },
    content: { default: '' },
    by: { default: '' },
    status: { default: 'pending' },
    // ... Phase 0 의 Mark 모델과 동일한 attrs
  },
  parseDOM: [{ tag: 'span[data-proof-mark="suggestion"]', getAttrs: (el) => ({ /* ... */ }) }],
  toDOM: (mark) => ['span', { 'data-proof-mark': 'suggestion', 'data-id': mark.attrs.id, /* ... */ }, 0],
  parseMarkdown: { /* ... */ },
  toMarkdown: { /* ... */ },
}))

export const proofComment = $markSchema(...)
export const proofAuthored = $markSchema(...)

export const proofMarkPlugins: MilkdownPlugin[] = [
  proofSuggestion,
  proofComment,
  proofAuthored,
].flat()
```

### codeBlockExtPlugins 처리
proof-sdk 의 `code-block-ext` 는 `code_block` 노드를 재정의해서 안에 proof 마크 허용. 우리도 같은 필요 있음 (제안 마크가 코드블록 안에서도 동작해야).

옵션:
- (a) proof-sdk 의 `code-block-ext.ts` 를 그대로 베껴오기
- (b) Milkdown 기본 `commonmark` 의 `code_block` 노드를 직접 override

작업량 적은 (a) 권장.

### frontmatterSchema
우리는 frontmatter 안 씀 (`proofMarks.ts:46~50` 주석 참조 — "register only for symmetry"). proof-sdk 제거 후엔 등록 필요 없음. 제거.

## Tauri 설정 변경

### `src-tauri/Cargo.toml`
- proof-server 의존성 확인 — 없으면 변화 없음
- libc (kill 시그널용) 필요 없으면 제거

### `src-tauri/capabilities/default.json`
- proof-server 관련 permission 있으면 제거 (있을지 확인)
- `dialog:default`, `fs:*` 등 Export 관련 권한은 보존 (다른 기능에서 쓸 가능성)

## 마이그레이션 — 기존 사용자 데이터

유저 0 이므로:
- Dev 환경: `~/Library/Application Support/com.writer-tauri.dev/` 의 IDB 데이터베이스 wipe
- 사이드카가 만든 SQLite (`/proof-sdk/server/*.db`) 무시
- Phase 0 의 새 Mark 모델 + Phase 1 의 markStore 로 doc 들이 다시 만들어짐

옵션: 부팅 시 한 번만 실행되는 `migrate-legacy-marks.ts` 스크립트로 기존 Y.Map('marks') + Y.Map('authoredMeta') 를 새 Mark 형태로 변환. 유저 0 이라 생략 가능하지만 dev 환경 보존하고 싶으면 작성.

## 시작 흐름 변화

### 현재 (`apps/writer-tauri/src-tauri/src/lib.rs:408 부근`)
```
[proof-server] workspace root: /path/to/rabat
[proof-server] killed leftover pid=...
[proof-server] spawned pid=...
[sidecar manager] CLAUDE_CODE_CLI_PATH=...
[sidecar manager] spawning chat + title sidecars
[proof-sdk] listening on http://127.0.0.1:4000
...
```

### Phase 3 후
```
[sidecar manager] CLAUDE_CODE_CLI_PATH=...
[sidecar manager] spawning chat + title sidecars
[sidecar manager] both sidecars initialized
```

→ proof-server 관련 log 사라짐. claude-agent-sdk 사이드카 (chat / title) 는 그대로 — 이건 proof-sdk 와 무관.

## 검증 — grep zero

```
Grep "proof-sdk" → 0건
Grep "proofClient" → 0건
Grep "proof-server" → 0건 (lib.rs 의 주석에서도 제거)
Grep "@proof-sdk" → 0건 (package.json 포함)
Grep "PROOF_BASE_URL" → 0건
Grep "localhost:4000" → 0건 (proof-server 의 포트)
Grep "HocuspocusProvider" → 0건 (3B 시)
```

## 검증 — 시나리오 회귀

Phase 2 의 회귀 테스트 9개 + 추가:

10. 앱 부팅 시 proof-server spawn 시도 안 함 (로그 확인)
11. 앱 부팅 시간 측정 — 사이드카 spawn 없으니 0.5~1초 빨라짐 기대
12. 마크 데이터가 IDB 에 정상 저장 + 앱 재시작 시 복원
13. (3B 시) WebSocket 연결 시도 안 함 (network 탭 확인)
14. (3A 시) 자체 Hocuspocus 서버 띄움 + sync 동작

## 완료 기준

- [ ] 위 grep 7개 모두 0건
- [ ] 앱 정상 부팅 (proof-server 관련 에러 없음)
- [ ] Phase 2 회귀 테스트 9개 + 신규 4개 통과
- [ ] `apps/writer-tauri/src-tauri/binaries/` 디렉토리 비어 있음 (또는 claude 관련만)
- [ ] `package.json` 에 `@proof-sdk/*` 의존 0건

## 다음 단계
Phase 4 — `agent/ingest.ts` 709줄 분해. 순수 리팩토링.

## 위험

| 위험 | 완충 |
|---|---|
| 마크 schema 이식 시 미묘한 attr 차이로 기존 마크 렌더 깨짐 | proof-sdk 의 schema 파일을 그대로 베껴옴 (변형 안 함). 차이는 Phase 0 의 7→3 종류 좁힘에서만 발생 |
| Hocuspocus 제거 후 단일 기기 시나리오에서도 sync 문제 발생 | useCollabDoc 의 idb + Y.UndoManager 만으로 충분히 작동. provider 없는 경로는 이미 'offline' 상태로 코드에 있음 (e.g. MilkdownEditor.tsx:340 의 `if (provider?.awareness)`) |
| Tauri capabilities 빠뜨려서 다른 기능이 깨짐 | 변경 전 capabilities 백업. 변경은 proof-server 관련만 명시적으로 제거 |
| 사용자 환경의 기존 IDB 데이터가 새 schema 와 호환 안 됨 | 유저 0 이라 무시. 필요 시 `migrate-legacy-marks.ts` 스크립트 추가 |
| EngineGate 제거 후 부팅 흐름이 깨짐 | EngineGate 가 가진 다른 책임 확인. proof-server health 외에 다른 게이팅 있으면 별도 컴포넌트로 추출 후 EngineGate 만 제거 |
