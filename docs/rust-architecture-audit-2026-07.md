# Rust 아키텍처 감사 — "Rust 네이티브 · 다중 AI" 의도 대비 현실

> **목적**: Octave는 "Rust 네이티브 기반으로 여러 AI를 빠르고 효율적으로 돌린다"는 의도로
> 구조를 짰다. 그 사이 주먹구구로 개발되며 이 의도를 해치는 구조가 생겼는지를
> 코드 실측으로 판정하고, 실행 가능한 순서로 전환한다.
>
> **작성일**: 2026-07-28
> **방법**: Rust 전량 직접 읽기 + 3개 병렬 심층 감사(사이드카 동시성 / Rust 호스트 / 프론트엔드 소유권).
> 상위 항목은 전부 코드에서 직접 재확인함 (`cargo check --tests` 포함 실측).
> **범례**: 심각도 P0(재난) > P1(전략) > P2(부채)
> **후속 문서**: `docs/zed-acp-comparison-2026-07.md` (Zed/ACP 대조 및 차용 설계)

---

## 0. 먼저 — 지금 Rust 테스트가 컴파일되지 않는다 · P0

```
$ cargo check --tests
error[E0425]: cannot find function `credential_helper_args` in this scope
  --> src/git.rs:921:20
error[E0425]: cannot find function `credential_helper_args` in this scope
  --> src/git.rs:937:18
error: could not compile `writer-tauri` (lib test) due to 2 previous errors
```

직접 재현함. 삭제된 `git_push` 기능의 테스트 잔해다. `src/git.rs:917`은 `unused import: super::*` 경고까지 낸다 — 모듈이 통째로 고아 상태.

**결과: crate의 단위 테스트 20개가 전부 죽어 있다.**

| 파일 | 테스트 수 | 덮는 것 |
|---|---:|---|
| `claude_sidecar/framing.rs` | 5 | 프레이밍 분할·다중·malformed |
| `claude_sidecar/manager.rs` | 5 | 크래시루프 백오프 정책, 이벤트명 매핑 |
| `models_catalog.rs` | 5 | 모델 카탈로그 파싱 |
| `git.rs` | 2 | — |
| `claude_import.rs` | 2 | — |
| `claude_sidecar/state.rs` | 1 | 와이어 계약 직렬화 |

`cargo check`(`--tests` 없이)는 **통과**하기 때문에 아무도 보지 못했다.
"에러가 전혀 없어야 하는 제품"에서 Rust 쪽 안전망이 조용히 꺼져 있었다.

> **수정 비용: 수 분.** 이것이 0순위다.

---

## 1. 판정

의도가 어긋난 지점은 하나다. **Rust가 AI 실행에 대해 아무 책임도 갖고 있지 않다.**

Rust는 에이전트가 존재한다는 사실조차 모른다. `claude_chat_start`(`commands.rs:182`)는
JSON 뭉치를 만들어 넘길 뿐 레지스트리도, 카운터도, 큐도 없다. Rust의 유일한 Map은
전송 계층의 `pending: HashMap<i64, oneshot::Sender>`(`client.rs:91`)로, run이 뭔지 모른다.

### 1.1 구조 지도 (실측)

| 층 | 줄수 | 실제로 소유하는 것 |
|---|---:|---|
| Rust host | 5,816 | 프로세스 수명, OAuth, git 호출, 업데이터, 창 |
| └ `claude_sidecar/` | 1,859 | JSON-RPC 배관 — **결정 0, 에이전트 상태 0** |
| Node sidecar | 7,105 | 스레드·세션·툴·권한·샌드박스 = 진짜 오케스트레이션 |
| TS frontend | 63,534 | run 레지스트리, abort, 스트리밍 버퍼, 편집 적용, 볼트 인덱싱 |

**11:1로 TS가 Rust를 압도한다.** 이 비율 자체가 답이다.

### 1.2 중요한 반전 — 사이드카 엔진은 제대로 돼 있다

통념과 반대로, 동시성의 **심장은 살아 있다**:

- 스레드마다 독립 `query()` — `server.mjs:264` `activeThreads: Map<threadId, ThreadRec>`
- 스레드마다 독립 `AbortController` (`:825`), 독립 FIFO 큐 (`:838`), 독립 `canUseTool` 게이트 (`:968`)
- 전역 락 없음, in-flight 플래그 없음
- `runToThread`(`:268`)가 runId→thread를 demux
- 대기 맵 3종(`pendingDecisions`/`pendingAcks`/`pendingQueries`)은 전부 UUID 키 — 호출 단위로 올바름
- `index.mjs:44`가 `server.handle(msg)`를 fire-and-forget으로 호출 → 스레드 간 직렬화 없음
- 사이드카에 동기 fs 호출 **0건**

두 스레드가 동시에 대화해도 서로 막지 않는다.
**망가진 건 그 위아래 배관이다.**

---

## 2. 성능 — "빠르게"를 깨는 것

### 2-1. 에이전트 **한 개**가 이미 메인 스레드를 다 쓴다 · P0

`src/chat/ui/usePacedText.ts:55`:
```ts
const offsets = useMemo(() => graphemeOffsets(content), [content])
```
`content`는 120ms 플러시(`useChatRunner.ts:183`)마다 바뀐다 →
**매번 답변 전체에 `Intl.Segmenter`를 다시 돌린다.**

`:75-84`의 rAF 루프가 이걸 초당 ~60회 재스케줄하고, `:88`이
`content.slice(0, offsets[n])`로 전체 길이 문자열을 새로 할당한다.
그 문자열이 `<ReactMarkdown>`에 그대로 들어가(`StreamingMarkdown.tsx:214-219`)
remark/rehype가 **문서 전체를 매 프레임 재파싱**한다. 증분 파서 없음, 블록 단위 memo 없음.

**측정치** (V8 기준. WKWebView의 JavaScriptCore는 더 느림):

| 항목 | 비용 |
|---|---|
| 10.2KB 답변 remark+gfm 파싱 | **14.1ms/회** (mdast까지만, rehype·React 재조정 제외) |
| 12KB `graphemeOffsets` | 1.19ms/회 |
| 250회 플러시 누적 `Intl.Segmenter` | 68.7ms |
| 프레임 예산 | **16.6ms** |

**답변 하나가 파싱만으로 프레임 예산을 넘긴다.**
두 번째 에이전트가 문제가 아니라 첫 번째가 이미 예산을 다 쓴다.
다른 에이전트의 이벤트 처리, zod 검증, `pendingChangesStore` 쓰기, CodeMirror가 전부 그 뒤에 줄을 선다.

### 2-2. 스트리밍 팬아웃이 `창 수 × 동시 run 수` · P0

- `server.mjs:915` `includePartialMessages: true` → 토큰 델타 전부가 firehose로.
  `:917-918`에 `forwardSubagentText` / `agentProgressSummaries`도 켜져 있음
- `server.mjs:1163` — 모든 이벤트를 무필터로 emit
- `client.rs:341` — `on_notification`을 **읽기 루프 안에서 동기 호출**
- `manager.rs:452` — `app.emit(event_name, params)`. **`emit_to`가 아님. 모든 창에 브로드캐스트.**
  창은 프로젝트마다 뜬다(`projectWindow.ts:69`, capability `["main","project-*"]`).
  Rust는 `params` 안에 `runId`를 손에 쥐고도 버린다
- `chat/index.ts:431` — `if (!parseChatEvent(e.payload) || e.payload.runId !== runId) return`.
  **zod `safeParse`를 먼저 돌리고 나서** 남의 이벤트를 버린다. `z.looseObject`(`eventSchemas.ts:33`)라 사본까지 할당
- `runChat` 하나가 리스너를 **10개** 건다 (`:430, 451, 781, 806, 832, 853, 874, 895, 903, 947`),
  전부 하나의 `Promise.all` 안 = run 단위

토큰 하나당 `W`번 JSON 직렬화 + `W × 10K`번 JS 콜백, 그중 정확히 1개만 주인이다.

Tauri 내부 비용: `EmitArgs::new` → `serde_json::to_string(&Value)` → 창마다
`emit_js_script(...)`로 이스케이프된 JS 문자열을 새로 만들어 `eval`, 전역
`js_event_listeners` `std::Mutex` 아래에서.

**`tauri::ipc::Channel` 사용처는 코드베이스 전체 0건.**

> **정답이 이미 코드베이스에 두 번 있다.** `usePermissionGate.ts`와
> `backgroundTaskListener.ts:47`이 앱 1회 마운트 + runId 맵 demux 패턴이다.
> 주석이 왜 `runChat`만 예외인지 밝힌다:
> > "Kept OUT of agent/chat/index.ts on purpose: the runChat module is shared
> > with another in-flight refactor" — `usePermissionGate.ts:8-10`
>
> **설계 결정이 아니라 미룬 마이그레이션이다.**

### 2-3. 서브에이전트 토큰이 4개 층을 건너와서 버려진다 · P1

사이드카에 `parent_tool_use_id` 필터가 없다 → 서브에이전트 `stream_event`가 전부 firehose를 탄다.
그리고 `streamParser.ts:183`에서 `if (parentId) return`으로 **맨 마지막에 버린다**
(`forwardSubagentText`가 각 서브에이전트 메시지를 전문으로 한 번 더 주기 때문에 이중계산 방지).

서브에이전트 5개 팬아웃 = 5개 토큰 스트림이
Node→파이프→Rust JSON→창별 emit→창별 zod를 다 거친 뒤 폐기.
`server.mjs:1145`에서 한 줄로 막을 수 있다.

### 2-4. 채팅 시작마다 전역 뮤텍스 안에서 `ioreg` 프로세스를 띄운다 · P0

```
commands.rs:187  try_inject_token_chat          ← 모든 채팅 시작
→ manager.rs:271 → manager.rs:236
→ oauth.rs:269   REFRESH_LOCK.lock().await      ← 프로세스 전역 static AsyncMutex (oauth.rs:26)
→ oauth.rs:271   load_token
→ secure_storage.rs:68  fs::read                ← 블로킹
→ secure_storage.rs:29  machine_uid::get()
→ machine-uid-0.5.4:139  Command::new("ioreg").output()   ← 블로킹 서브프로세스 spawn+wait
```

**측정: `ioreg -rd1 -c IOPlatformExpertDevice` = 약 10ms** (3회 평균, 1885바이트 출력).

에이전트 10개 동시 시작 = **락을 쥔 채 100ms 이상 직렬화**, 각각 tokio 워커 스레드를
*블로킹으로* 점유(await가 아님). 그리고 각 시작은 공유 파이프로 `setToken` 왕복을 한 번 더 한다
(`manager.rs:295-297` → `commands.rs:250`).

**더 나쁜 경우**: 실제 갱신이 필요하면 `do_refresh`(`oauth.rs:222-262`)가
**락을 쥔 채 네트워크 POST**를 한다(최대 15초 타임아웃 + 10초 연결).
그 동안 앱의 모든 채팅 시작·제목·모델 목록이 블록된다.
`oauth.rs:223-227` 주석이 이 위험을 알고 타임아웃을 "load-bearing"이라 부르는데,
그건 완화지 해결이 아니다. `get_claude_token`은 커맨드로도 노출돼(`lib.rs:70`)
렌더러도 이 락에 경합할 수 있다.

키는 불변 머신 ID에서 나온다. `OnceLock` 하나면 사라진다.

### 2-5. 볼트 스캔이 JS에서 파일당 직렬 IPC · P1

```ts
const entries = await readDir(absPath)                  // scanVault.ts:72 — 디렉토리마다 1회
const sub = await listMdRecursive(childRel)             // :78 — 병렬 없음
for (const mdRel of allMd) { await mintDocMeta(mdRel) } // :245 — 전 파일 본문 순차 읽기
```

`mintDocMeta`는 **본문 전체를 읽어 frontmatter만 쓰고 버린다**(`:50`).
노트 2,000개 = IPC 왕복 2,000+회, 전부 직렬, 부팅·볼트 전환마다. 렌더러 메인 스레드에서.

- Rust에 vault 읽기/쓰기 커맨드가 **하나도 없다**. `lib.rs:66-119`의 44개 커맨드 중 0개
- `Cargo.toml`에 `walkdir` / `ignore` / `tantivy` / `globset` **전무**
- **전문 검색 기능이 아예 없다.** 커맨드 팔레트는 인메모리 `knownDocs` 배열 필터
- `plugin-fs` 호출 39곳 / 9파일, 그중 28곳이 `src/lib/vault.ts`. capability scope는 `$HOME/**`
- 코드베이스 전체에 **Web Worker도 `worker_threads`도 없다**

거기에 `vaultWatcher.ts:165` → `vault.ts:215`:
저장할 때마다 **파일 전체를 다시 읽어 SHA-256**을 계산한다(에코 억제용). 쓰기마다 읽기 왕복이 붙는다.
생성/삭제는 400ms 디바운스 후 트리 전체 재귀 `readDir`(`vault.ts:452-481`).

### 2-6. 제안 하나마다 localStorage에 문서 본문을 동기 직렬화 · P1

- `pendingChangesStore.ts:493` — `partialize: (s) => ({ byId: s.byId })` (맵 전체 영속)
- `:296` — `const snapshot = readDocBody(change.pageSlug)` (**전체 본문** 스냅샷 저장)
- `propose_write`는 `edits[].after`에 새 본문 전문도 담는다
- zustand `persist`는 기본 storage에서 매 `set`마다 **동기** 기록 — push / accept / reject /
  `markViewed` / `markFeedbackDelivered` / `pruneDecided` 전부

에이전트 N개가 편집 제안 → N번의 전체 맵 직렬화(before+after 본문 포함)가
이미 2-1로 묶인 스레드에서 돈다. localStorage는 수 MB 문서 스냅샷의 자리가 아니다.

### 2-7. 매 턴 16KB를 만들어 보내고 사이드카가 버린다 · P2

`DEFAULT_CLAUDE_MD` 15,368바이트(`wikiService.ts:201-203`이 무조건 반환) +
프로필 요약 전문(`systemPrompt.ts:204-221`) + preferences 파일 전문(`:222-224`)을
매 턴 재조립해 보낸다.

사이드카는 `systemPrompt`를 **스레드 생성 시 고정**하고 이후 턴에서 버린다.
`server.mjs:601-602`가 직접 명시:

> "fixed at thread creation (no control request exists): systemPrompt, builtinTools,
> relayTools, allowDelegation, sandboxEnabled, vaultPath, maxTurns, gitDir, gitWorkTree"
> …
> "The failure mode is silence: the host resends every param on every turn, and the reuse
> path in #handleChatPersistent simply drops the fixed ones. Nothing errors. `effort` sat
> broken this way … until it was measured."

같은 핫패스의 다른 낭비:
- `referencedFilesBlock`이 @-mention 본문을 원장 없이 전문 삽입(`systemPrompt.ts:401-414`) →
  같은 파일을 다시 언급하면 사본이 매 턴 추가
- settle이 `pendingChangesStore.byId` 전체를 run마다 O(n) 스캔(`chat/index.ts:406-408`)

**잘 된 것**: 볼트 인덱스는 의도적으로 재전송하지 않고(`contextPipeline.ts:16-22`),
문서 본문은 원장 게이트를 통과한다(`chat/index.ts:257`).

### 2-8. 메시지 리스트에 가상화가 없다 · P2

- `ChatPanel.tsx:816` — `renderedTurns.map(...)`, 전량 마운트. `package.json`에 윈도잉 라이브러리 없음
- `PartList.tsx:45` — `usePendingChangesStore((s) => s.byId)`로 **맵 전체 구독**.
  `MessageRow`는 `React.memo`인데(`MessageRow.tsx:24`) 구독이 그 *안*에 있어 memo가 무력 →
  아무 에이전트의 제안 하나가 트랜스크립트의 모든 `PartList`를 재렌더,
  각각 O(parts) + 새 `Map`/`Set`/`filter` 할당(`PartList.tsx:63-106`)
- `TaskActivity.tsx:36-42` — 셀렉터가 id 하나 찾으려고 **전 스레드 × 전 태스크**를 선형 스캔.
  마운트된 레인 행마다, `backgroundTasks` 업데이트마다 → 레인 F개면 하트비트 배치당 O(F²)
- `usePacedText.ts:55` — 정착 메시지 50개짜리 스레드를 열면 마운트 시점에
  50개 전문에 `Intl.Segmenter`를 돌린다

에이전트 수와 함께 자라는 정확히 두 축(제안 수, 레인 수)에서 나쁘게 스케일한다.

---

## 3. 정확성 — 동시 실행에서 깨지는 것

전부 코드에서 직접 확인함.

### 3-1. 통째쓰기 CAS 기준선이 slug 전역 · P0 (무음 데이터 유실)

```ts
// src/agent/modelBodyBase.ts:38-39
const baseBySlug = new Map<string, string>()
const staleCountBySlug = new Map<string, number>()
```

run 키가 없다. `setModelBase(slug, body)`는 `runChat`의 세 지점에서 호출된다
(`chat/index.ts:251, 264, 282`).

같은 노트를 건드리는 에이전트 둘이 **하나의 기준선과 하나의 `MAX_STALE_RETRIES` 예산**을 공유한다.
B가 A의 기준선을 덮으면, A의 `propose_write`는 **자기가 본 적 없는 본문**을 상대로 CAS를 통과한다.

이건 그 CAS 게이트가 막으려고 만들어진 바로 그 무음 덮어쓰기이고,
**동시성이 그 방어를 무력화하는 조건**이다. "여러 AI"를 표방하는 제품은 반드시 두 에이전트가
한 노트를 만나는 경우를 만난다.

`noteContextLedger.ts:24`는 이미 올바르게 키를 잡고 있다 — 여기만 안 됐다.

### 3-2. `MAX_LIVE_THREADS`가 fail-open · P1

```js
// server.mjs:1555-1566
#maybeEvictLRU() {
  if (this.activeThreads.size < MAX_LIVE_THREADS) return   // MAX_LIVE_THREADS = 6 (:2030)
  let victim = null
  for (const [, rec] of this.activeThreads) {
    if (rec.dead || this.#threadBusy(rec)) continue
    if (!victim || rec.lastTurnEndedAt < victim.lastTurnEndedAt) victim = rec
  }
  if (victim) this.#teardownThread(victim, 'lru_evict')
}
```

`:821`에서 호출되고 `:873`에서 `activeThreads.set(threadId, rec)`이 실행된다.
**전부 바쁘면 `victim`이 null이고, 아무것도 안 쫓아내고 7번째를 그냥 만든다.**
호출부 주석은 "Bound live subprocesses"라고 하는데 bound하지 않는다.
동시 10개 = CLI 서브프로세스 10개, 입장 제어·큐·백프레셔 없음.

반대 경우가 지연에는 더 나쁘다: 유휴 스레드가 있으면 7번째마다 하나를 축출하고,
그 에이전트의 다음 턴은 CLI 재기동 + 디스크 세션 복원(`sessionPersisted`가 `dir` 없이
`~/.claude/projects` 전체를 `readdir`+stat) + 콜드 프롬프트 캐시를 전부 낸다.
6개 넘게 돌리면 전환마다 이 비용이다.

### 3-3. 제목 single-flight를 아무도 받지 않는다 · P1

```js
// server.mjs:470-472
if (this.mode === 'title' && this.activeThreads.size > 0) {
  this.emit(errorResponse(id, BUSY, 'title sidecar is single-flight'))
  return
}
```

`PROTOCOL.md:476`은 **"The Rust host queues title requests"**라고 쓰여 있다.
**큐는 없다** — `commands.rs:392-415`는 그대로 전달하고 문자열로 뭉갠다.

```ts
// generateThreadTitle.ts:102-106
.catch((err) => { console.warn('[generateThreadTitle] failed', err); clearTimeout(timer); settle(null) })
```

코드 검사도, 재시도도, 백오프도 없다.
**에이전트 5개 동시 시작 → 4개 스레드는 영구히 30자 잘라쓰기 제목.**

### 3-4. 릴레이 툴이 턴 사이에 `runId: null`을 찍는다 · P1 (잠복)

릴레이 MCP 서버는 `() => rec.currentRunId`로 만들어지고(`server.mjs:1116`),
`#settleTurn`이 `rec.currentRunId = null`로 지운다(`:1403`).

부모 턴이 끝난 뒤 백그라운드 서브에이전트가 `propose_edit` / `move_note` / `set_note_status`를
부르면 `chat/edit-pending`이 `runId: null`로 나가고, 모든 프론트 리스너의
`e.payload.runId !== runId` 필터가 **조용히 버린다**.

바로 옆 `chat/task`는 이미 폴백이 있다:
```js
runId: rec.turnActive ? rec.currentRunId : (rec.bgTurnRunId ?? null)   // :1520
```
`chat/event`도 합성 `bgTurnRunId`를 민다(`:1160`). **릴레이 getter만 안 고쳐졌다.**

`server.mjs:1863`이 오늘 `background: true` 에이전트를 아무것도 안 보낸다고 적어놨기 때문에
지금은 잠복이다. **병렬 서브에이전트가 실제로 일하는 순간 발현한다.**

### 3-5. 사이드카 재시작이 CLI 손자를 흘린다 · P1

`manager.rs:386-389`가 `*self.chat.write().await`를 새 `Arc`로 교체한다.
옛 `SidecarClient`가 drop → `client.rs:104-109` 태스크 abort → `Child` drop →
`kill_on_drop`(`client.rs:133`).

그런데 `client.rs:93-96`과 `manager.rs:206-211`이 **둘 다** 명시한다:
`kill_on_drop`은 **직계 자식만 거둔다. 그게 바로 손자가 고아가 되는 이유다.**
그 해답이 `hard_kill()`(`client.rs:201`, `killpg(-pid, SIGKILL)`)이다.

`shutdown_all`은 호출한다(`manager.rs:228-229`). **`restart`는 절대 호출하지 않는다.**

`MAX_LIVE_THREADS = 6`이면 살아있는 사이드카가 `claude` CLI 6개+를 거느린다.
dev 핫리스타트 왓처(`manager.rs:529-534`)는 `.mjs` 저장마다 살아있는 사이드카를 재시작하므로
**저장할 때마다 한 세대씩 흘린다.**

> **수정**: 스왑 전에 옛 `Arc`를 캡처해 `.hard_kill()`.

### 3-6. AUTH 갱신 조율이 전역이고 동시 대기자를 떨어뜨린다 · P2

```js
if (token !== previousToken && this.tokenUpdateWaiters.length > 0)   // server.mjs:368
```

스레드 A가 AUTH → 갱신 요청 → 호스트가 새 토큰 설치 → A 진행.
스레드 B가 잠시 뒤 AUTH → 호스트가 **이미 신선한 같은 토큰**을 밀면 `!==` 가드가 false →
B의 waiter가 안 깨고 5초 뒤 타임아웃(`:1951`) → 유저에게 AUTH 에러.
겹칠 확률은 에이전트 수와 함께 오른다.

### 3-7. 파일 쓰기의 주인이 셋 · P0 (저장유실 계열의 구조적 뿌리)

| 쓰는 주체 | 경로 | 미저장 에디터 상태를 보는가 |
|---|---|---|
| SDK `Write`/`Edit` 툴 | 사이드카가 **디스크 직접** (`server.mjs:1078`) | ❌ |
| `docBody.ts:105-160` JS keyed mutex | 렌더러 (**우회 호출처 37곳**) | ✅ |
| `vaultWatcher` 에코 억제 | 되읽기 + SHA-256 | — |

세 프로세스가 같은 트리에 쓰는데 **공유 락이 없다.**
원자적 쓰기는 JS에서 재구현돼 있고(`vault.ts:243-256`),
경로 탈출 방어도 JS에 있다(`vault.ts:87`).

이것이 `bodyMarkdown`이 stale로 남는 이유이고, auto-accept 저장유실 계열의 뿌리다.

### 3-8. 실행 중 에이전트 기록이 가장 휘발성 높은 층에만 있다 · P1

- `stores/chatRuns.ts` — 영속화 없는 순수 메모리 zustand (`AbortController` 맵)
- `stores/turnState.ts` — 스트리밍 버퍼, 턴 중에는 절대 영속화 안 됨
- `stores/backgroundTasks.ts` — 순수 인메모리, 리로드 시 소실
- 어시스턴트 턴이 디스크에 닿는 유일한 지점은 `useChatRunner.ts:215` `appendTurn(...)`,
  `commit()` 안 → **`claude:done` / `claude:error` 때만**

**웹뷰 리로드(⌘R)**: 리스너 전부 사망, `chatRuns`·`turnState` 초기화.
사이드카의 `activeThreads`(`server.mjs:264`)는 멀쩡히 계속 생성한다.
사이드카가 전문을 갖고 있는 진행 중 답변이 **영구 소실**된다.
복구 경로 없음 — `reconnect|resumeRun|recoverRun` 검색 결과 0건.

**창 닫기**: `useWindowClose.ts:74`가 확인 후 `current.destroy()`를 부르지만 abort는 안 한다.
`useChaRuns.abortAll()`(`chatRuns.ts:86`)은 **정의만 있고 호출처 0**.

Rust의 `sidecar_status`(`state.rs:79`)는 **프로세스 생사만** 알고 run은 모른다.
세 층 중 유일하게 둘 다에서 살아남는 층(Rust)이 무엇이 돌고 있는지 모른다.

**잠복 레이스**: `chat/index.ts:429`가 `Promise.all([listen…])`을 await하지 않고
`:977`에서 `await invoke('claude_chat_start')`를 한다. 보통은 리스너 등록이 타이밍상 이기지만
보장이 아니고, Tauri는 리스너 없는 이벤트를 드랍한다.

### 3-9. git에 직렬화가 없다 · P1

`git.rs` 전체에 뮤텍스도, per-vault 락도 없다. 그리고 있어도 소용없다 —
`commands.rs:210-213`이 의도적으로 `gitDir`/`gitWorkTree`를 사이드카에 주입해서
모델의 `Bash`가 진짜 repo에 `git revert` / `git log`를 직접 돌리게 한다.

한편 `git_commit`(`git.rs:511-534`)은 락 없이 git 4번을 연속 호출하고
(`add -A`, `diff --cached`, `commit`, `rev-parse`),
`docFileSync`는 500ms JS 타이머로 flush한다(`docFileSync.ts:395`).
모든 창이 같은 vault에 대해 `git_commit`을 동시 호출할 수 있다.

에이전트 N개 편집·커밋 + 호스트 오토커밋 → `.git/index.lock` 경합은 **운이 아니라 타이밍 문제**다.
`git_commit`은 이걸 `Err(String)`(`git.rs:192` `git exit 128: …`)으로 내보내고,
프론트는 분류도 재시도도 못 한다.

### 3-10. 파킹된 권한 게이트가 스레드 닫힐 때 샌다 · P2

`#requestDecision`은 abort 리스너를 `rec.turnController.signal`에 건다(`server.mjs:1734`).
그런데 `#teardownThread`는 `rec.controller`만 abort한다(`:1627`).

`chat/close-thread`로 스레드를 닫거나 종료 중에 `AskUserQuestion` / `ExitPlanMode` 게이트가
파킹돼 있으면 `pendingDecisions` 엔트리와 그 프로미스가 **영원히 pending**으로 남는다.

### 3-11. 에러가 전부 `String` · P1

`client.rs:27-44`에 thiserror로 잘 만든 `SidecarError`가 있다:
`Exited` / `Rpc { code, message, data }` / `ProtocolMismatch` / `Send` / `Io` / `Json`.

모든 커맨드가 버린다 — `commands.rs:190, 252, 267, 282, 301, 311, 330, 352, 385, 399, 414`
전부 `.map_err(|e| e.to_string())`.

프론트는 "사이드카가 mid-restart로 죽음"과 "인증 만료"와 "번들이 stale"과 "레이트리밋"을
**영어 문장 부분매칭**으로만 구분한다. 동시 N 에이전트에서 재시도/백오프 결정이야말로
기계가 읽을 수 있는 판별자가 필요한 자리다.

통합 테스트는 이미 타입 형태에 의존한다(`tests/sidecar_e2e.rs:267-269`이
`SidecarError::Rpc { code, .. }`를 `-32001`과 매칭). 타입은 유용한데 IPC 경계에서 지워진다.
Tauri v2는 `#[derive(Serialize)]` 에러 열거형을 직접 지원한다.

**이것이 3-3의 BUSY를 못 잡는 직접 원인이다.**

### 3-12. 커맨드에서 도달 가능한 panic 경로 · P2

`Cargo.toml:52`가 릴리스에 `panic = "abort"`를 건다 →
어느 스레드든 panic 하나가 앱 전체를 죽이고 진행 중 에이전트를 전부 떨군다.

| 지점 | 트리거 | 도달 경로 |
|---|---|---|
| `window_chrome.rs:323` `.lock().unwrap()` | 뮤텍스 poison | `is_window_compact` |
| `window_chrome.rs:267, 289` `.lock().unwrap()` | 뮤텍스 poison | `set_window_compact` |
| `manager.rs:315, 399` `.lock().unwrap()` | `RestartGuard` poison | 사이드카 종료 핸들러 |
| `appdata.rs:26` `.expect("appdata::init must run…")` | setup에서 `app_data_dir()` 실패 | **`claude_chat_start` → `commands.rs:210`** |

`client.rs:143-144`의 `.expect("stdin piped")`는 안전하고(앞선 `Stdio::piped()`가 보장),
`lib.rs:330`은 시작 전용이다. 뮤텍스 `unwrap()`들은 확률이 낮지만 이득이 0이다 —
crate의 다른 락 지점은 이미 전부 poison을 관대하게 다룬다(`updater.rs:151`, `state.rs:66`).
정책이 아니라 불일치다.

### 3-13. 블로킹 `std::fs`가 async 커맨드 안에 · P2

Tauri 커맨드는 공유 async 런타임에서 돈다(`tauri/src/ipc/mod.rs:329` → `async_runtime::spawn`).

| 지점 | 블로킹 작업 | 최악 |
|---|---|---|
| `git.rs:300` → `:304` → `:209` `copy_dir_recursive` | **`.git` 디렉토리 전체 재귀 `std::fs` 복사** (EXDEV 폴백) | 무제한 — 큰 히스토리에선 초~분 |
| `git.rs:378-382, 433-437, 477` | `.gitignore` `write`/`read_to_string` | ~1ms |
| `git.rs:288` `write_vault_git_pointer` | `read_to_string` + `write` | ~1ms, **매 부팅** |
| `appdata.rs:34-36, 43` | `create_dir_all` + `canonicalize` | ~0.1–1ms, **매 채팅 시작**(`commands.rs:210`) |
| `claude_import.rs:88` | `~/.claude/commands/*.md`·`agents/*.md` 전량 읽기 | 10–100ms |
| `claude_import.rs:103` → `:136` | 재귀 `std::fs` 복사 | 무제한 |
| `fetch_url.rs:231` | 최대 20MB base64 인코딩 | ~20–50ms CPU |

**대조로 올바른 것**: `updater.rs:333`은 `update.install`에 `spawn_blocking`,
`google_oauth.rs:318`은 루프백 서버에 `spawn_blocking`(그래서 `:208`의 `thread::sleep`이 괜찮음).
`git.rs`의 실제 git 호출은 전부 `tokio::process`(`git.rs:25`). `reqwest::blocking` 없음.
**패턴을 알고 있는데 일관되게 적용만 안 됐다.**

### 3-14. 동기 커맨드가 메인 스레드에서 실파일 작업을 한다 · P2

`async`가 아닌 `#[tauri::command]`는 `ExecutionContext::Blocking`이 기본이라
IPC 핸들러 스레드 = 메인 스레드에서 인라인 실행된다.

동기 커맨드: `sidecar_status`, `updater_status`, `updater_arm_restart_when_idle`,
`updater_restart_veto`, `get_traffic_light_y`, `apply_window_chrome`, `set_window_compact`,
`is_window_compact`, `move_to_trash`, `reveal_in_finder`, `play_system_sound`.

- **`os_trash.rs:23` `move_to_trash`** — `-[NSFileManager trashItemAtURL:]`을 **UI 스레드에서**.
  큰 노트 폴더를 버리면 창이 언다. `async` + `spawn_blocking`이어야 한다
- `reveal.rs:10`, `sound.rs:19` — 메인 스레드에서 블로킹 `std::process::Command::spawn()` (~1–5ms)
- 나머지는 진짜 싼 락 읽기이거나 AppKit이라 메인 스레드여야 한다

---

## 4. 계약 — 손으로 3~4벌, 이미 드리프트함

코드젠이 없다. `src-tauri/Cargo.toml`에 `ts-rs`/`specta`/`tauri-specta`/`schemars` 없고,
어느 `package.json`에도 `typeshare`/`zod-to-*` 없다.

기계 검증되는 유일한 불변식은 정수 하나 — `PROTOCOL_VERSION`
(`client.rs:25` == `server.mjs:182`, `client.rs:221-229`에서 assert).
**페이로드 모양이 바뀌어도 안 올라간다.** stale 패키징만 잡는다.

채팅 요청 스키마는 **네 벌**:
`chat/index.ts:977-1041` → `commands.rs:19-108`(구조체) →
`commands.rs:192-247`(문자열 키로 손수 재직렬화 22번) → `server.mjs:462-518, 826-860`.

필드 추가 = 4곳 수정, **하나 놓쳐도 아무것도 실패하지 않는다.**
`server.mjs:605-609`가 이 실패 모드가 **이미 `effort`를 물었다**고 기록해두었다.

### 4.1 이미 어긋난 사본

| # | 계약 | 드리프트 |
|---|---|---|
| 1 | `PROTOCOL.md:158-166` chat params | `tools: [{name, schema}]`를 문서화 — 실제는 `relayTools: string[]`. 예시 툴 `propose_change`는 존재하지 않음. 라이브 파라미터 14개 미문서화 |
| 2 | `chat/proposal` | 사이드카가 **한 번도 emit하지 않음**. 그런데 전부 문서화돼 있고(`PROTOCOL.md:333-351`) Rust 테스트가 검증(`manager.rs:757`). 죽은 분기 |
| 3 | `PROTOCOL.md` §4 | 라이브 채널 11개 중 **6개 누락** (`chat/task`, `skill-pending`, `move-note`, `set-status`, `set-tags`, `query-notes`). `manager.rs:411`의 기계적 `chat/<x>`→`claude:<x>` 규칙 덕에 **문서 없이도 그냥 동작해서** 아무도 안 고침 |
| 4 | 에러 코드 | `errors.mjs:38-88`에 14개, `PROTOCOL.md:390`에 5개, `errorMessage.ts:21-49`가 `SIDECAR_DIED`를 추가 — 이건 어느 사이드카도 emit하지 않음(`chat/index.ts:950`에서 호스트가 합성) |
| 5 | `rate_limit_info` | `types.ts:300-305`는 4필드 선언, 사이드카는 `overageInUse`/`overageStatus`/`overageResetsAt`/`overageDisabledReason`를 읽음(`server.mjs:1183`, `errors.mjs:16-28`). TS에 거의 동일한 모양 두 벌(`types.ts:167-174`, `:392-396`) |
| 6 | `initialize` 결과 | 문서는 `sdkVersion` 약속(`PROTOCOL.md:88-95`), 사이드카는 안 보내고 미문서 `mode`를 보냄(`server.mjs:344-349`) |
| 7 | `permissionMode: 'acceptEdits'` | `types.ts:77`에 선언. **한 번도 안 보냄**(`useChatRunner.ts:336`은 `plan`/`default`만). 사이드카 분기도 없음. 실제 동작은 호스트 전용 `autoAcceptEdits` |
| 8 | `effort` | `commands.rs:46-47` 주석이 `"max"` 허용을 주장 — 다른 어디에도 없음. 유니온이 `ChatEffort`(`chat/types.ts:130`)를 import하지 않고 `agent/chat/types.ts:60`에 인라인 재선언 |
| 9 | `SidecarState` | `state.rs:24-25`가 "mirrored 1:1 by the TS `SidecarState` union"이라 주장 — **그런 TS 타입은 없다.** 두 소비자 모두 임시 `{status: string; mode: string}`(`chat/index.ts:947`, `chatRun.ts:127`) |
| 10 | 프레이밍 | 한 와이어 포맷에 독립 구현 두 벌(`framing.rs` vs `jsonrpc.mjs`). malformed 입력에서 갈림 — Node는 `-32700` 응답, Rust는 조용히 드랍(`client.rs:296-300`) |
| 11 | `claude_chat_stop_task` | 3개 층 전부 구현(`lib.rs:87`, `commands.rs:274`, `server.mjs:1929`)인데 **TS 호출처 0**. 따라서 `TaskEvent.status: 'stopped'`는 도달 불가 |

릴레이 채널 6개(`edit-pending`, `skill-pending`, `move-note`, `set-status`, `set-tags`, `query-notes`)는
`chat/index.ts:451, 781, 806, 832, 853, 874`에 **익명 인라인 제네릭**으로 손으로 옮겨 적혀 있고
**런타임 검증이 전혀 없다**. zod 봉투가 있는 건 `event`/`done`/`error`/`task` 넷뿐.

`sidecar-pkg/`는 올바르게 gitignore돼 있고 현재 `sidecar/src/`와 바이트 동일,
`.input-hash`로 보호된다(`scripts/pack-sidecar.sh:15-31`).
다만 dev는 `sidecar/src`를 돌리고(mtime 왓처, `manager.rs:495-520`) prod는 팩된 사본을 돌린다 —
**prod만 stale해질 수 있다.**

---

## 5. 지킬 것 — 리팩터링에 쓸려가면 안 되는 것

**Rust 코드의 품질은 높다. 양이 부족한 게 아니라 책임이 없다.**

### 전송 계층
- **`client.rs` JSON-RPC 멀티플렉싱** — `AtomicI64` id(`:242`) + `HashMap<i64, oneshot::Sender>`(`:253`).
  진짜 동시 다중화이고 `tests/sidecar_e2e.rs:171-180`이 검증
- **양쪽 경로에서 pending을 실패 처리** — 프로세스 종료(`:176-179`), stdout EOF(`:347-350`). 행 없음
- **응답 판별이 미묘하고 올바름** — `result`/`error`가 아니라 `id` 유무로 게이트,
  이유까지 주석에 있음(`:317-320`: `result: null`이 유효한 성공 페이로드)
- **`framing.rs`** — 분할 청크, 한 read에 여러 메시지, 비UTF8, 잘못된 헤더, 대소문자 무시 전부 처리.
  스트리밍 기반이라 줄 길이 가정 없음
- **`write_tx` `mpsc::channel(64)`**(`:149`) — Rust→Node 백프레셔는 올바름

### 프로세스 관리
- **크래시루프 감독**(`manager.rs:68-84`) — 지수 백오프 + healthy-uptime 리셋 + 하드 캡을
  순수 함수 `restart_decision`으로 분리하고 테스트까지
- **프로세스 그룹 리더 spawn + `hard_kill`**(`client.rs:138-139, 201-209`) —
  CLI 손자 고아에 대한 올바른 답. `restart`에 배선만 안 됐다(3-5)
- **`notification_event_name`**(`manager.rs:411-415`)이 매치 테이블이 아니라 기계적 —
  새 채널이 조용히 드랍되지 않는 이유

### 사이드카
- **스레드별 엔진** — 다중 AI의 실제 엔진, 제대로 돼 있음
- **동기 fs 호출 0건**
- **`threadBusy` 술어를 export해서 공유**(`server.mjs:2014`) — 테스트가 재진술하지 않음
- **`#applyThreadControls`의 frozen-param 문서화 + 1회 경고**(`server.mjs:595-650`) —
  실패가 침묵인 지점을 알고 계측해둔 흔적
- **`chat/edit-ack`**(`commands.rs:339`) — "제안이 실제로 큐에 들어갔나"를 되묻는
  잘 설계된 백프레셔 신호

### 프론트엔드
- **팬아웃이 JS에서 스케줄되지 않음** — 서브에이전트 생성은 SDK `Task`가 사이드카 안에서.
  지속 쿼리 경로(`server.mjs:505`, 기본 ON per `settingsStore.ts:169`)가 스레드당 장수 쿼리를
  유지해 백그라운드 태스크가 턴 경계를 넘어 생존(`server.mjs:867, 1503`).
  프론트는 `claude:task`로 관찰만. **올바른 분업**
- **에디터 저장이 키 입력마다 재직렬화하지 않음** —
  `buildExtensions.ts:253`이 더티 플래그만 세우고, `docFileSync.ts:741`이 500ms 간격으로 flush,
  라이브 CodeMirror 상태에서 당겨옴(`docFileSync.ts:155`)
- **볼트 인덱스를 의도적으로 재전송하지 않음**(`contextPipeline.ts:16-22`)
- **두 개의 전역 demux 리스너**(`usePermissionGate.ts`, `backgroundTaskListener.ts`) —
  올바른 팬아웃 패턴이 이미 코드베이스에 존재한다는 증거

### 기타
- **`updater.rs`** — 백엔드 소유 상태머신, 스로틀된 진행률, 블로킹 설치에 `spawn_blocking`,
  staged 업데이트를 절대 강등하지 않음
- **`fetch_url.rs`** — 진짜 SSRF 가드, 증분 크기 캡, 명시적 타임아웃
- **`std::Mutex`를 `.await` 너머로 쥔 곳이 crate 전체에 0건** (11곳 전부 개별 확인)

### 5.1 락 인벤토리

| 락 | 위치 | 지키는 것 | 쥐는 시간 | 10 에이전트에서 병목? |
|---|---|---|---|---|
| `REFRESH_LOCK` (static AsyncMutex) | `oauth.rs:26` | 토큰 read+refresh | **fs read + `ioreg` spawn (~10ms), 또는 15초 네트워크 POST** | **예 — 최악.** 2-4 참조 |
| `REFRESH_LOCK` (google) | `google_oauth.rs:55` | Google 토큰 | 동일 모양 | 아니오 (에이전트 경로 아님) |
| `pending` `tokio::Mutex<HashMap>` | `client.rs:91` | JSON-RPC id → oneshot | µs, insert/remove만 | 아니오 — 올바름 |
| `write_tx` `mpsc(64)` | `client.rs:149` | stdin 프레임 | 유계 큐 | 아니오 — 올바른 백프레셔 |
| `chat`/`title` `RwLock<Arc<Client>>` | `manager.rs:107-108` | 현재 클라이언트 | Arc read-clone | 아니오 |
| `chat_restart`/`title_restart` `std::Mutex` | `manager.rs:113-114` | 크래시루프 카운터 | 문 범위, **await 전에 해제**(`:314-322`) | 아니오 |
| `SidecarSupervisorState.last` `std::Mutex` | `state.rs:59` | 모드별 마지막 상태 | HashMap insert 1회 | 아니오 |
| `UpdaterState.inner` `std::Mutex` | `updater.rs:124` | busy/last/ready/armed | 필드 read-write | 아니오 |
| `PendingOAuth` `std::Mutex` | `oauth.rs:52` | PKCE verifier | 블록 범위 `take()` | 아니오 |
| `CompactFrames` `std::Mutex` | `window_chrome.rs:218` | 창별 프레임 보관 | 메인 스레드 클로저 | 아니오 |
| `BASE` `OnceLock` | `appdata.rs:15` | 앱데이터 루트 | 1회 설정 | 아니오 (단 `.expect()` — 3-12) |
| `SelfRef` `OnceLock<Weak>` | `manager.rs:19` | 매니저 역참조 | 1회 설정 | 아니오 |

---

## 6. 정리 순서

**0~4는 오늘 안에 끝난다.**

| # | 할 일 | 근거 | 크기 |
|---|---|---|---|
| **0** | `credential_helper_args` 잔해 삭제 → `cargo test` 컴파일 복구 | §0 | 분 |
| **1** | 토큰·키 `OnceLock` 캐시. 채팅 시작마다 `ioreg` 안 띄우기 | 2-4 | ~30줄 |
| **2** | `modelBodyBase`를 runId로 키잉 | 3-1 | 소 |
| **3** | 릴레이 getter에 `?? rec.bgTurnRunId` | 3-4 | 극소 |
| **4** | `restart`에서 스왑 전 `old.hard_kill()` | 3-5 | 극소 |
| **5** | 단일 비행 마크다운 파싱 래치 | 2-1 | ~3줄 상태 |
| **6** | `usePacedText`를 타이머 + 적응형 예산으로 | 2-1 | ~40줄 |
| **7** | `MAX_LIVE_THREADS`를 진짜 경계로 (큐 or 거부) 또는 상수 삭제 | 3-2 | 소 |
| **8** | `chat/event`를 run별 `tauri::ipc::Channel`로 + `&RawValue` 통과 | 2-2 | 중 |
| **9** | 서브에이전트 `stream_event` 드랍 (`server.mjs:1145`) | 2-3 | 극소 |
| **10** | `SidecarError`를 타입 그대로 프론트까지 | 3-11 (3-3의 선결) | 소 |
| **11** | `spawn_blocking` for §3-13 사이트, `move_to_trash` async화 | 3-13, 3-14 | 소 |
| **12** | 채팅 리스트 가상화 | 2-8 | 중 |
| **13** | 볼트 스캔/인덱스를 Rust 커맨드로 (walkdir + 병렬 frontmatter) | 2-5 | 중 |
| **14** | vault 쓰기 + git을 Rust 단일 writer 액터로 | 3-7, 3-9 | 대 |
| **15** | `PROTOCOL.md` 정정 + 계약 단일화 | §4 | 중 |
| — | 사이드카 프로세스 풀 | 8·13·14 하고도 부족할 때. **지금은 시기상조** | — |

**5·6·8이 "빠르게"의 대부분, 13·14가 "Rust 네이티브"의 대부분,
0·2·3·4가 "에러가 전혀 없어야"의 대부분이다.**

---

## 7. 한 줄 요약

구조가 의도를 배신한 게 아니라, **의도한 일을 Rust에게 준 적이 없다.**
Rust는 잘 쓰인 바이트 파이프이고, 에이전트 스케줄링·이벤트 라우팅·파일 쓰기·인덱싱은
전부 그 위 두 층(Node 이벤트 루프 하나, React 메인 스레드 하나)에 얹혀 있다.

되돌리는 데 가장 효율이 높은 단일 변경은 **8번 — Rust가 run별 이벤트 스트림을 소유하는 것**이다.
그 하나로 창 증폭, 이중 직렬화, zod-후-폐기가 동시에 사라지고,
Rust에 `runId → {thread, window, channel}` 레지스트리가 생기면서 이후 13·14의 발판이 된다.
