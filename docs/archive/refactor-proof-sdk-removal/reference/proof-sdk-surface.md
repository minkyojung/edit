# Reference — proof-sdk surface 맵

이 문서는 **현재 우리 코드에 proof-sdk 가 어떻게 박혀 있는지** 정리한 참조 문서다. Phase 3 (제거) 의 작업 목록이자, Phase 1~2 의 "대체할 표면 정의" 의 기초.

## 1. 런타임 의존 — proof-server (Rust 사이드카)

### 어디서 spawn 되나
`apps/writer-tauri/src-tauri/src/lib.rs:187` — `spawn_proof_server(workspace_root)`
- Dev: workspace 루트의 `proof-sdk/server/index.ts` 를 bun 으로 실행
- Prod: 번들된 바이너리 `apps/writer-tauri/src-tauri/binaries/proof-server-aarch64-apple-darwin` 실행
- 포트 `localhost:4000` 바인딩
- 시작 시 stale process kill (`apps/writer-tauri/src-tauri/src/lib.rs:177` 부근)

### 어디서 shutdown 되나
`apps/writer-tauri/src-tauri/src/lib.rs:41` — `shutdown_proof_server(app)`
- SIGTERM 보냄 → 6초 graceful budget 대기 (`GRACEFUL_SHUTDOWN_BUDGET`) → 안 죽으면 force-kill
- 두 진입점 모두 호출: `RunEvent::Exit` (Cmd+Q) + `WindowEvent::Destroyed` (X 버튼)

### 프론트엔드 health check
- `apps/writer-tauri/src-tauri/src/lib.rs:93` — `check_proof_server_health` (Tauri command)
- `apps/writer-tauri/src-tauri/src/lib.rs:113` — `respawn_proof_server` (Tauri command, EngineGate 에서 호출)
- `apps/writer-tauri/src/components/EngineGate.tsx` — 부팅 시 health 확인 + 실패 시 respawn 트리거

## 2. HTTP 클라이언트 — proofClient

### 위치
`apps/writer-tauri/src/lib/proofClient.ts` (177줄)

### 메서드
```ts
proofClient.createDoc(title, markdown, { slug? }) → { slug, alreadyExisted? }
proofClient.getCollabSession(slug)                  → { session: { collabWsUrl, token, role, syncProtocol } }
proofClient.deleteDocForever(slug)                  → { success: true }
proofClient.ops(slug, token, payload)               → OpsResponse
```

### OpsPayload 종류 (proofClient.ts:130~138)
```ts
| { type: 'comment.add'; quote; text; by }
| { type: 'comment.reply'; markId; text; by }
| { type: 'comment.resolve'; markId; by }
| { type: 'comment.unresolve'; markId; by }
| { type: 'suggestion.add'; kind: 'insert'|'delete'|'replace'; quote; content?; by; status? }
| { type: 'suggestion.accept'; markId; by }
| { type: 'suggestion.reject'; markId; by }
| { type: 'rewrite.apply'; content; by }
```

### 실제 사용되는 ops
- `comment.add` — `MarkToolbar` 가 코멘트 마크 생성 (현재 미연결 — 직접 Y.Map 씀)
- `comment.resolve` — `markActions.cleanupMark` 가 코멘트 마크 정리
- `suggestion.add` — `applyProposal` 이 AI 제안 마크 생성
- `suggestion.accept` — `markActions.acceptMark`
- `suggestion.reject` — `markActions.rejectMark`, `cleanupMark`

### OpsResponse
```ts
{ markId?, id?, revision?, success?, ... }
```
캐치할 에러: `OpsError` (proofClient.ts:155) — `code` 에 `ANCHOR_NOT_FOUND` / `STALE_REVISION` / `PROJECTION_STALE` / `IDEMPOTENCY_KEY_REQUIRED` 등.

## 3. 에디터 스키마 — proof-sdk 의 마크/노드 정의

### 위치
`apps/writer-tauri/src/editor/proofMarks.ts` (63줄) — 얇은 어댑터

### 가져오는 것
```ts
import { proofMarkPlugins } from '@proof-sdk/editor/schema/proof-marks'
import { codeBlockExtPlugins } from '@proof-sdk/editor/schema/code-block-ext'
import { frontmatterSchema } from '@proof-sdk/editor/schema/frontmatter'
```

세 가지 모두 Milkdown `MilkdownPlugin[]` 으로 flat + cast 해서 export.

### 각 plugin 의 역할
| Plugin | 무엇 |
|---|---|
| `proofMarkPlugins` | 7개 마크 schema: `proofAuthored`, `proofApproved`, `proofFlagged`, `proofComment`, `proofSuggestion` (insert/delete/replace 한 노드에서 attr 로 구분), `proofProvenance` |
| `codeBlockExtPlugins` | `code_block` 노드를 재정의 — 안에 proof 마크 허용 |
| `frontmatterSchema` | YAML frontmatter 블록 노드 (우리는 안 씀, 호환용) |

### MilkdownEditor.tsx 에서의 등록
`apps/writer-tauri/src/editor/MilkdownEditor.tsx:211` — `.use(proofSchemaPlugins)`.
등록 순서: commonmark → gfm → listItemBlock → keymap → collab → dailyGuard → **proofSchemaPlugins** → 커스텀 plugin 들.

### 우리가 실제로 쓰는 마크
- `proofSuggestion` (AI 제안) — `applyProposal`, `markActions.accept/reject`
- `proofComment` (사용자 코멘트) — `MarkToolbar`, `MarkPopoverLayer`
- `proofAuthored` (출처 breadcrumb) — accept 후 stamp 됨

미사용:
- `proofApproved`, `proofFlagged`, `proofProvenance` (legacy, `authoredMeta` 로 대체됨)

## 4. TypeScript shim

### 위치
`apps/writer-tauri/src/types/proof-sdk.d.ts`

### 무엇
proof-sdk 모듈을 opaque 하게 선언 → Vite 가 런타임에 alias 로 resolve 하는 동안 TypeScript 는 타입 체크 통과.

### Vite alias
`apps/writer-tauri/vite.config.ts` 에 `"@proof-sdk": path.resolve(__dirname, "../../../proof-sdk/src")` 추가됨.

## 5. 마크 데이터 모델

### StoredMark — `apps/writer-tauri/src/hooks/useCollabDoc.ts:13~53`

```ts
type MarkKind =
  | 'authored' | 'approved' | 'flagged' | 'comment'
  | 'insert' | 'delete' | 'replace' | 'provenance'

interface StoredMark {
  id?: string
  kind: MarkKind
  by?: string
  at?: string
  quote?: string
  range?: { from: number; to: number }
  startRel?: string  // Y.RelativePosition encoded
  endRel?: string
  content?: string
  status?: 'pending' | 'accepted' | 'rejected'
  text?: string
  resolved?: boolean
  orphaned?: boolean
  note?: string
  sourceQuote?: string
  sourceSlug?: string
  sourceLabel?: string
  createdAt?: string
  proposedAt?: string  // @deprecated
  acceptedAt?: string
  model?: string
}
```

### 저장 위치
- `ydoc.getMap<StoredMark>('marks')` — 마크 메타 본체
- `ydoc.getMap<AuthoredMeta>('authoredMeta')` — proof-sdk 가 안 다루는 추가 메타 (sourceSlug, model, acceptedAt 등). 같은 mark id 로 키 됨.

→ **두 곳에 마크 메타가 분산됨.** Phase 0 에서 통합 대상.

## 6. proof-sdk import 가 있는 파일 (전체)

`grep "proof-sdk\|proofClient\|proof-server"` 결과 — 30개 파일:

### 직접 의존 (제거 대상)
- `apps/writer-tauri/src/lib/proofClient.ts` ✕ 전체 삭제
- `apps/writer-tauri/src/editor/proofMarks.ts` ✕ schema 자체 import 부분 제거 후 우리 정의로 교체
- `apps/writer-tauri/src/types/proof-sdk.d.ts` ✕ 삭제
- `apps/writer-tauri/vite.config.ts` ✕ alias 제거
- `apps/writer-tauri/src-tauri/src/lib.rs` ✕ spawn / shutdown / health / respawn 모두 제거
- `apps/writer-tauri/src-tauri/binaries/proof-server-*` ✕ 바이너리 제거
- `apps/writer-tauri/scripts/setup-binaries.sh` — proof-server 다운로드 부분 제거

### 호출자 (Phase 2 에서 markStore 로 교체)
- `apps/writer-tauri/src/agent/applyProposal.ts` — `proofClient.ops` 사용 (suggestion.add, comment.add)
- `apps/writer-tauri/src/editor/markActions.ts` — `proofClient.ops` 사용 (suggestion.accept/reject, comment.resolve)
- `apps/writer-tauri/src/layout/MarkToolbar.tsx` — 현재 직접 Y.Map (아직 ops 사용 안 함). markStore 로 교체.
- `apps/writer-tauri/src/layout/WikiPageBanner.tsx` — accept 흐름. markStore.accept 호출로.
- `apps/writer-tauri/src/state/wikiService.ts` — `proofClient.createDoc`, `proofClient.deleteDocForever`. 로컬 doc 관리 로직으로 교체.
- `apps/writer-tauri/src/state/docsStore.ts` — `proofClient.getCollabSession`, `createDoc`, `deleteDocForever`. 로컬 / 자체 sync 로 교체.
- `apps/writer-tauri/src/agent/chat.ts`, `applyIngest.ts`, `ingest.ts` — `PROOF_BASE_URL` 직접 사용. 제거.

### 부수적
- `apps/writer-tauri/src/components/EngineGate.tsx` — proof-server health gate. 통째 제거 또는 우리 부팅 체크로 교체.
- `apps/writer-tauri/src/hooks/useIdleTrigger.ts` — proof-server 의존 부분 있음
- `apps/writer-tauri/src/export/types.ts` — proof-sdk 타입 import. 자체 타입으로.

## 7. 협업 (Hocuspocus / Yjs) — **유지**

이 부분은 proof-sdk 와 별개의 의존. **제거 안 함.**

- `@hocuspocus/provider` — WebSocket sync provider
- `yjs`, `y-prosemirror`, `y-indexeddb` — CRDT + 로컬 영속성
- Yjs UndoManager — `MilkdownEditor.tsx:294~342`

proof-server 가 Hocuspocus 서버 역할도 함 → 제거 시 **자체 Hocuspocus 서버** 가 필요하거나, **로컬 IDB-only 모드** 로 전환해야 함. 

후자를 권장 (단일 유저 위주이므로). Phase 3 에서 구체화.

## 8. proof-server 가 우리에게 제공한 것 vs 우리가 자체 구현할 것

| proof-server 제공 | 우리 대체 |
|---|---|
| Hocuspocus WebSocket sync | 자체 Hocuspocus 서버 OR 단일 기기 IDB-only |
| Mark 의 canonical mutation (`/ops`) | `markStore.add/accept/reject` 클라이언트 단 |
| Markdown ↔ Y.Doc projection | 우리 Milkdown 의 markdownText utility |
| SQLite 영속성 (documents, marks 컬럼) | IndexedDB 만 사용. 필요 시 file export |
| Drift detector / projection repair | 폐기. drift 시 "stale" 표시. |
| Collab session 토큰 / 인증 | 단일 유저라 불필요. 멀티유저 협업 시 재설계. |
| Delete / hard delete | 클라이언트 단 IDB clear |

## 9. 제거 후 잃는 기능

명시적으로 잃는 것:
- 멀티 디바이스 동기화 (자체 서버 안 만들면)
- 향후 멀티유저 협업 (재구현 필요)
- 마크다운으로 export 시 mark 보존 (현재도 보류 중인 Export 기능에서만 쓰이는 부분)

명시적으로 안 잃는 것:
- 모든 mark 종류의 작동 (자체 구현)
- 모든 24개 커스텀 Milkdown 플러그인 (wikilink, daily, slash menu 등)
- Yjs CRDT + UndoManager + IDB 영속성
- ingest / chat / wiki 흐름
