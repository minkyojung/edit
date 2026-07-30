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
>
> ---
>
> **정정 이력 (2026-07-29)** — §6의 0~4번을 실제로 구현하면서 처방 다섯 중 셋이
> 틀렸고 하나가 불충분함이 드러났다. 각 항목을 고친 자리에 **⚠️ 정정**으로
> 표시하고 왜 틀렸는지를 남겨둔다. 결론만 바꿔두면 다음 사람이 원래 처방으로
> 되돌리기 때문이다.
>
> | # | 원래 처방 | 판정 |
> |---|---|---|
> | 0 | 잔해 삭제 → 테스트 20개 부활 | 18개 (2개는 삭제 대상 자신) |
> | 1 | 토큰·키 `OnceLock` 캐시 | 키만. 토큰 캐시는 폐기된 토큰을 서빙 |
> | 2 | `modelBodyBase`를 runId로 키잉 | **threadId.** runId면 2턴째부터 CAS가 꺼짐 |
> | 3 | 릴레이에 `?? bgTurnRunId` | 불충분. 호스트 쪽 절반이 따로 있음 |
> | 4 | `restart`에서 `hard_kill` | **`Drop`.** 원안대로면 재시작 폭주 |
> | 5 | 단일 비행 파싱 래치 | **적용 불가.** 걸 대상이 없다 (§2-1) |
> | 6 | `usePacedText`를 타이머로 | 타이머가 아니라 **커밋 속도 제한** |
> | 2-8 | `PartList`를 "가상화 없음" P2로 분류 | **오분류.** 독립 결함이고 606ms 멈춤 |
>
> 구현·검증·커밋 완료: `e073770d9` `9e0f346a3` `f7a47993c` `5219d7239` `f1203f28a`
> `1d230572b` `37d5f007a` `fcc596b7a` `a305dc579`. 감사에 없던 버그 2건은 §3-15에 추가.

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

**결과: crate의 단위 테스트가 전부 죽어 있다.**

> **⚠️ 정정 (2026-07-29)**: "20개 부활"은 틀렸다. **18개다.** 아래 표의 `git.rs` 2개는
> 부활하는 게 아니라 **삭제되는 대상 자신**이다. `credential_helper_args`는
> 커밋 `8ce06ba11`("remove the GitHub integration")이 git.rs의 원격 절반을
> 통째로 지우면서 함께 사라졌고, 그 커밋 메시지가 이 두 테스트를 남긴 것도
> 명시해 두었다. 살아있는 호출처는 없다(`GH_TOKEN`/`credential.helper`/`git_push`
> 전역 grep이 죽은 테스트와 낡은 주석만 잡는다) — 그러므로 함수를 복원하는
> 게 아니라 **테스트를 지우는 것**이 맞다.

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

> **⚠️ 정정 — 진짜 이유**: "`--tests` 없이는 통과해서"는 정확하지 않다.
> `.github/workflows/ci.yml`에는 **cargo 잡이 아예 없다**(frontend 잡 하나뿐:
> lint/typecheck/vitest/vite build). CI가 Rust를 한 번도 돌린 적이 없다는 게
> 방치된 진짜 이유다. Rust 잡을 붙이려면 bun 다운로드 + `sidecar-pkg` 패킹
> (286MB) + 캐싱이 선행돼야 한다 — 별도 판단이 필요한 항목.

> **⚠️ 선결 조건 (문서에 없던 것)**: `cargo check --tests`는 이 잔해에 **도달조차
> 못 한다.** 그 전에 `build.rs`의 `tauri_build::build()`가 번들 설정을 검증하다
> 죽는다 — 서브커맨드와 무관하므로 `check`·`--tests`·`test`가 모두 막힌다.
> 세 가지가 필요하다:
>
> 1. `binaries/bun-<triple>` → `pnpm setup:binaries` (평소엔 `postinstall`이 처리)
> 2. `sidecar-pkg/` → `pnpm pack:sidecar`
> 3. `secrets/google_client_id`·`_secret` → 원본 워크스페이스에서 복사
>    (gitignored이고 `.worktreeinclude`가 복사하지 않아 새 워크스페이스마다 재발)

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

> **⚠️ 정정 (2026-07-29) — 진단은 맞고, 원인 지목이 절반 틀렸다.** 고침 (`37d5f007a`).
>
> **`graphemeOffsets`는 주범이 아니다.** `content` 변경(초당 8.3회)마다 도는 것이지
> 프레임마다가 아니다. 지배적 비용은 **`react-markdown`의 재파싱** 하나다.
> 단계별 실측: 파이프라인 조립 0.001ms(무시 가능), **`parse` 8.9ms**,
> `runSync` 1.3ms. "매 렌더 파이프라인을 새로 만든다"는 사실이지만 비용이 아니다.
>
> **그리고 초당 60회는 튜닝 사고가 아니라 구조적 귀결이다.** 프레임당 잔량의 1/8을
> 흘려보내므로 120ms 도착 주기 동안 잔량은 (7/8)^7.2 ≈ 0.38로만 준다. 토큰이
> 계속 오는 한 **0에 도달하지 못해 rAF 루프가 멈추지 않는다.**
>
> **실측 (제품 함수 + 실제 파이프라인으로 스트리밍 한 판 시뮬레이션):**
>
> | 답변 | 수정 전 | 수정 후 |
> |---|---|---|
> | 4KB | 메인스레드 15.6%, 최악 7.0ms | 5.1%, 5.6ms |
> | 10KB | 36.5%, 23.4ms | 10.2%, 13.5ms |
> | 20KB | **73.6%, 최악 261ms** | **13.5%, 28.0ms** |
>
> 261ms는 "느림"이 아니라 "멈춤"이다.
>
> ---
>
> **#5(단일 비행 파싱 래치)는 적용 불가능하다.** Zed는 파싱을 **백그라운드 스레드**
> (`cx.background_spawn`)에서 하므로 "하나 진행 중 + 하나 대기"가 성립한다.
> 반면 `react-markdown`은 **렌더 안에서 동기 파싱**한다 —
> 한 스레드에서 동기 파싱 둘이 동시에 돌 수 없으므로 **래치를 걸 대상이 없다.**
> (`zed-acp-comparison` §5가 두 절 앞에서 "완료 블록 memo가 낫다"고 이미 적어놨다.)
>
> **#5의 대안으로 검토된 "블록 분할 + memo"도 채택하지 않았다.** Streamdown,
> LibreChat, AI SDK 쿡북이 쓰는 업계 표준이지만 **우리 파이프라인으로 실측하니
> 13개 마크다운 구조 중 4개가 어떤 경계 규칙으로도 안 고쳐진다** — 참조형 링크,
> 참조형 이미지, 각주, HTML 블록. 정의와 참조가 *진짜로* 다른 최상위 블록에 있기
> 때문이고, micromark 메인테이너가 증분 파싱을 거부한 이유와 같다:
> *"문서 첫 줄의 무언가가 마지막 줄에 영향을 줄 수 있다."*
> (빈 줄로 자르면 13개 중 **9개**가 깨진다.)
>
> 출시된 `streamdown@2.5.0`이 지금 참조형 링크를 날것 텍스트로 그린다 — 각주엔
> 통째-폴백 탈출구를 만들었는데 링크 정의엔 없다. 업스트림에 보고된 적도 없다.
>
> **우리 고유 블로커도 둘 더 있다**: memo된 앞부분 안의 **Mermaid가 영구히
> 미완성 상태로 언다**(`isStreaming`이 턴 단위라 memo가 안 깨짐), 그리고 깨진
> **`[[위키링크]]`가 영영 안 낫는다**(`remarkWikilink`가 docs 스토어를 구독이 아니라
> 명령형으로 읽어서, 지금은 다음 렌더에 자가 치유된다).
>
> **실제로 한 것은 페이서의 커밋 속도 제한이다.** 의미를 전혀 안 건드리면서 파싱
> 횟수를 줄이는 유일한 지렛대다. assistant-ui가 `minCommitMs`로 같은 손잡이를
> 노출하고 같은 이유를 적어놨고, LobeChat은 꼬리 길이에 따라 간격을 넓힌다(32–96ms).
> 조사한 제품 4곳 전부가 **커밋 속도 제한을 첫 번째 조치로** 한다.
>
> **분할이 나중에 필요해지면** `@lezer/markdown`이 이미 직접 의존성이고
> (`package.json:35`, CodeMirror 경유) **진짜 증분 파서**다. 20KB에 한 줄 추가 시
> 전체 0.886ms vs 증분 0.043ms(20배), 두 트리가 노드 5,055개 전부 일치. 업계 표준이
> 쓰는 `marked`는 우리 트리에서 해석되지 않아 새 의존성이 된다.

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

> **⚠️ 정정 (2026-07-29)**: 표본 3회는 과소평가였다. **n=30 재측정: 평균 18.4ms,
> p50 17.2ms, p90 24.1ms, 최악 31.0ms.** 그리고 갱신이 실제로 도는 턴에는 두 번
> 돈다 — `load_token`에서 한 번, `do_refresh` 안의 `save_token`에서 또 한 번,
> 둘 다 락 안에서. 약 37ms.
>
> `machine-uid` 0.5.4 소스도 확인했다: **내부 캐시가 전혀 없다.** 크레이트 전체가
> 한 파일이고 statics가 없어서 매 호출이 무조건 서브프로세스다.

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

> **⚠️ 정정 — 무엇을 캐시할지**: §6 #1의 "토큰·**키** `OnceLock` 캐시"에서
> **토큰은 빼야 한다.**
>
> - **토큰은 캐시 불가.** 설계상 회전하고(`oauth.rs:260`이 갱신마다 새로 씀),
>   `oauth.rs:289`·`:297`·`disconnect_claude`(`:313`) 세 곳에서 밖에서 삭제된다.
>   `OnceLock`은 쓰기 1회라 첫 토큰이 고정되고, 가변 캐시로 바꿔도 무효화 4곳
>   계약을 지지 않으면 **연결 해제한 뒤에도 폐기된 토큰을 서빙**한다.
>   `get_claude_account`(`:305`)는 디스크를 직접 읽으므로 캐시와 UI가 어긋난다.
> - **캐시할 계층은 `secure_storage.rs`의 `derive_key` 하나.** `machine_uid`는
>   리포 전체에서 여기 한 곳에서만 쓰이고 오직 키 재료다. 여기 넣으면
>   `oauth.rs`·`google_oauth.rs`를 건드리지 않아도 **구글 경로가 함께 고쳐진다.**
> - **`LazyLock`은 금지.** 초기화 클로저가 실패할 수 없어 `LazyLock<Result<..>>`가
>   되고, 그러면 **실패가 영구 기억된다** — 시작 시 `ioreg`가 한 번 튀면 그
>   프로세스는 재시도 없이 영영 토큰을 못 읽는다. `OnceLock<Result<..>>`도 동일.
>   성공만 기억하는 형태여야 한다.
>
> **`REFRESH_LOCK` 분리는 하지 않는다.** uid를 캐시해도 락은 여전히 15초 POST를
> 감싸지만, 그건 단일 비행 갱신이 제 일을 하는 것이다(동시 호출자가 서로의
> refresh 토큰을 무효화하는 걸 막는다). 분리하려면 위에서 위험하다고 판정한
> 토큰 캐시를 도입해야 하므로 **성능 문제가 아니라 보안 문제**다. 트리거:
> 실측된 경합, 또는 "갱신 뒤에서 채팅 시작이 멈췄다"는 실제 신고.
>
> 구현: `f1203f28a`.

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

> **⚠️ 정정 (2026-07-29) — `PartList` 항목은 분류가 틀렸다. P2가 아니고, 가상화 문제도
> 아니다.** 고침 (`fcc596b7a`, 그물 `a305dc579`).
>
> 이 절은 이걸 "가상화 없음"의 부작용으로 묶었지만, **가상화와 무관한 독립 결함**이다.
> `PartList`는 제안 맵 **전체**를 구독하면서 실제로는 **자기 파트의 `pendingId`가
> 살아있나**만 읽는다(`:87`). 안 쓰는 상태를 구독하는 것 — 그게 결함이다.
>
> 그래서 제안 도착 / Accept / Reject / `markApplyFailed` / 노트 전환 **어느 하나에도
> 스레드의 모든 메시지가 재파싱된다.** 실측:
>
> | 스레드 | 한 번의 동기 커밋 |
> |---|---|
> | 20개 메시지 × 2KB | 95ms |
> | 50개 × 4KB | **261ms** |
> | 50개 × 10KB | **606ms** |
>
> **스트리밍 최악(28ms)의 20배이고, 버튼을 누른 직후라 훨씬 잘 보인다.** 대화가
> 길수록 클릭 한 번이 비싸진다.
>
> 정석은 `React.memo`(피해 차단)가 아니라 **구독을 좁히는 것**(뿌리)이었다.
> `InlineSuggestion.tsx:36`이 이미 `s.byId[part.pendingId]`로 자기 것만 본다 —
> **`PartList`만 넓게 잡고 있었다.**
>
> 남은 memo 구멍 하나(감사에 없음): `ChatPanel.tsx:778`의 `handleRegenerate`가 일반
> 함수 선언이라 매 렌더 새 신원을 갖고, 마지막 정착 답변 행의 `React.memo`를 항상
> 실패시킨다. `useCallback` 한 줄. 미수정.

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

> **⚠️ 정정 (2026-07-29) — 키는 `runId`가 아니라 `threadId`다.** §6 #2의 처방을
> 그대로 따르면 **방어막이 지금보다 더 꺼진다.**
>
> `setModelBase`는 본문을 실제로 모델에게 보낼 때만 찍힌다
> (`chat/index.ts:263-266`, `sendBody`가 참일 때). 그런데 `sendBody`는
> `noteContextLedger`가 정하고, **원장의 일이 "같은 스레드 2턴째부터는 본문을
> 다시 보내지 않는 것"**이다. 그래서 run으로 키를 잡으면:
>
> 1. 1턴: 본문 전송 → `base[run1:note]` 기록
> 2. 2턴: 원장이 "이미 보여줬다" → 본문 미전송 → **`setModelBase` 미호출**
> 3. 2턴의 `propose_write`: `getModelBase(run2, note)` → `undefined`
> 4. `applyIngest.ts:194-196` — **undefined면 CAS를 건너뛴다**
>
> → **모든 대화의 2턴째부터 게이트가 통째로 꺼진다.** 지금은 "가끔 잘못된 기준선과
> 비교"인데, run 키잉은 "대부분 아예 비교 안 함"이 된다.
>
> 덧붙여 `runId`는 그 세 호출 지점에서 **스코프에 있지도 않다** — `chat/index.ts:337`
> 에서 발급되는데 셋은 그 위다. `threadId`는 `runChat` 인자라 바로 옆 253·265행에서
> 이미 쓰인다. 그리고 실제 동시성 축도 스레드다(`useChatRunner.ts:88-90`:
> *"keyed by threadId, so concurrent sessions each drive their own turn"*).
>
> **같은 뿌리의 두 번째 버그**: `staleCountBySlug`도 전역이라 B의 stale 바운스가
> A의 재시도 예산을 먹는다. A는 자기 **첫** 거부에서 `parked`가 되고,
> `notify.autoAcceptWriteFailed()`가 *"Couldn't save the AI's change / The file may
> be locked or unwritable"* 토스트를 띄운다 — **파일은 잠겨 있지 않다.** 거짓 진단.
>
> **덤**: `baseBySlug`를 비우는 코드가 제품에 없었다(`__resetModelBaseForTests`만).
> 노트 본문 전문을 앱 수명 내내 들고 있었다. 원장의 `forgetThreadNoteContext`
> 옆(`threadsStore.ts:243`)에 `forgetThreadModelBase`를 붙여 함께 해결.
>
> 구현: `f7a47993c`. CAS가 기준선 대 **라이브 본문**을 비교한다는 감사의 전제는
> 실측으로 확인됨(`docBody.ts:123` → `:136`)이라, 스레드 키잉만으로 완전한 수정이다.

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

> **⚠️ 정정 (2026-07-29) — `?? bgTurnRunId`는 수정이 아니다.** 두 가지 이유로
> 불충분하고, 이 항목은 §6의 "극소"가 아니라 #8(이벤트 채널 재배선)과 함께
> 가야 한다.
>
> **① 둘 다 null일 수 있다.** `bgTurnRunId`는 **메시지 스트림의 content 이벤트**를
> 봐야 발급된다(`server.mjs:1209-1211`). 그런데 **MCP 툴 호출은 컨트롤 채널로
> 온다**(`{subtype:'mcp_message'}`) — 다른 전송로이고, 서브에이전트의 `tool_use`
> 프레임이 핸들러 호출보다 먼저 도착한다는 보장이 없다. 부모 턴이 끝난 뒤
> 첫 릴레이 호출에서는 `bgTurnRunId`도 null일 가능성이 높다. **null을 낼 수 있는
> 폴백은 수정이 아니다.** 필요한 것은 `#settleTurn`이 절대 지우지 않는
> `rec.lastRunId`(→ `currentRunId ?? bgTurnRunId ?? lastRunId`).
>
> **② 호스트 쪽에 절반이 더 있다.** `chat/index.ts`의 `cleanup()`(`:380-390`)이
> **턴이 정착하는 순간 그 run의 리스너 10개를 전부 떼어낸다**(`settleOk`/`settleErr`).
> 즉 runId를 올바르게 채워도 **듣는 사람이 이미 없다.** 그리고 릴레이 페이로드에는
> `threadId`도 `background` 플래그도 없어서(`relay.mjs:118-125`) 앱 레벨
> `backgroundTaskListener` 패턴으로 라우팅할 수단조차 없다.
>
> 앱 레벨 리스너를 **복제**하는 것도 오답이다 — 지금 `edit-pending` 핸들러는 단순
> 전달이 아니라 새 노트 생성과 "한 턴에 같은 파일 두 번" 경쟁 조정(`newNoteByPath`)까지
> 한다. 정석은 복제가 아니라 **이동**(run별 등록 → 앱 레벨 + runId demux)이고,
> 그건 `usePermissionGate.ts:8-10` 주석이 *"runChat이 다른 리팩터와 겹쳐서 일부러
> 밖에 뒀다"*고 적어둔 바로 그 작업, 즉 §6 #8 영역이다.
>
> **SDK 판정 (설치 번들 실독)**: MCP 툴 핸들러는 호출자를 알 수 없다 —
> 시그니처가 `(args, extra: unknown)`이고 SDK가 `extra`에 아무것도 얹지 않는다.
> `canUseTool`의 `agentID?`와 훅의 `agent_id?`에는 있지만 MCP에는 연결돼 있지 않고,
> 있어도 소용없다: **`runId`는 호스트 개념이라 SDK가 존재조차 모른다.**
> 그러므로 ambient getter 자체는 SDK가 강제한 구조가 맞다. 강제되지 않은 건
> **그 칸이 null이 되도록 놔둔 것**이다.

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

> **⚠️ 정정 (2026-07-29) — 위 처방을 그대로 하면 재시작 폭주가 난다.**
>
> **왜 위험한가**: 지금 재시작이 조용한 건 `Drop`(`client.rs:104-110`)이 프로세스가
> 죽기 **전에** wait 태스크를 abort해서 exit 핸들러가 무장 해제되기 때문 —
> 우연한 순서 덕이다. `Arc`가 살아있는 상태에서 `hard_kill`을 부르면 핸들러가
> 무장된 채 프로세스가 죽고 → `handle_exit` → 크래시로 오인 → 방금 만든 인스턴스를
> 또 죽이는 재시작 → 5회 후 `Dead { fatal: true }`. dev 워처 경로에서는
> `last_spawn.elapsed()`가 `HEALTHY_UPTIME`(60초) 미만이라 카운터가 확실히 오른다.
>
> **위치도 틀렸다 — `restart`가 아니라 `Drop`이다.** 누수는 `restart` 고유 문제가
> 아니라 `Drop` 자체에 있고, 드랍 지점은 1곳이 아니라 **6곳**이다:
> ① `manager.rs:387`/`:388` 재시작 스왑(크래시 복구 + dev 워처)
> ② `spawn_initialized`가 `ProtocolMismatch`로 Err를 낼 때(`client.rs:234`)
> ③ `spawn_all`에서 title 스폰 실패 시 이미 뜬 chat(`manager.rs:144-151`)
> ④ `SidecarManager` 자체 드랍 ⑤ 테스트 클라이언트 2곳.
> `Drop` 하나가 전부를 덮는다.
>
> **정석**: `disarmed: AtomicBool` 하나를 kill·reap 중 먼저 오는 쪽이 `swap`하게
> 해서 ① 의도한 teardown은 핸들러를 쏘지 않고 ② 이미 수거된 pgid(재활용됐을 수
> 있는 pid)에 시그널을 보내지 않게 한다. `hard_kill`은 순수 `libc::kill`이라
> 동기·논블로킹이고 `Drop`에서 안전하다. `restart`는 무수정.
>
> 구현: `9e0f346a3`. 검증은 손자를 스폰하는 셸 픽스처 + `drop(client)` +
> `kill(pid,0)` — 토큰 없이 3초, 수정 전 실패 확인함
> (`tests/sidecar_process_group.rs`).

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

> **정정 (측정, 2026-07-30).** 표의 "**매 부팅**" 두 줄은 실제 비용이 추정치와
> 다르다. `git.rs`의 `boot_cost::measure_git_init_fast_path`(실제 볼트 + 실제
> app-data, `--ignored`)로 부팅이 타는 경로 그대로를 열 번 재면
> **첫 회 1.19ms, 이후 0.03ms**다. `write_vault_git_pointer`의 `read_to_string`
> 조기 반환과 `appdata`의 `create_dir_all`/`canonicalize`가 전부 합쳐 30마이크로초다.
> "~1ms 매 부팅"은 30배 과대평가였고, 부팅에서 고칠 것은 없다.
>
> 남는 건 표의 첫 줄 하나 — `copy_dir_recursive`. 다만 이건 `relocate_git_dir`의
> **조기 반환 세 개 뒤**에 있다(`.git` 없음 / `.git`이 우리 포인터 파일 / 외부
> git-dir이 이미 있음). 즉 볼트당 평생 한 번, 그것도 볼트와 app-data가 다른
> 볼륨일 때만 도는 마이그레이션이다. 그리고 3-14와 달리 이건 **UI 스레드가 아니라**
> tokio 워커 하나를 점유하는 것이다(Tauri는 `TokioRuntime::new()` = 멀티스레드).
> 사용자가 어차피 기다리는 최초 1회 마이그레이션에서 워커 하나를 쓰는 것이므로,
> 측정된 이득이 없다. **3-13은 결함이 아니다.** git 커맨드 열 개를
> `spawn_blocking`으로 옮기는 건 근거 없는 리팩터라 하지 않는다.

### 3-14. 동기 커맨드가 메인 스레드에서 실파일 작업을 한다 · P2

`async`가 아닌 `#[tauri::command]`는 `ExecutionContext::Blocking`이 기본이라
IPC 핸들러 스레드 = 메인 스레드에서 인라인 실행된다.

동기 커맨드: `sidecar_status`, `updater_status`, `updater_arm_restart_when_idle`,
`updater_restart_veto`, `get_traffic_light_y`, `apply_window_chrome`, `set_window_compact`,
`is_window_compact`, `move_to_trash`, `reveal_in_finder`, `play_system_sound`.

- **`os_trash.rs:23` `move_to_trash`** — `-[NSFileManager trashItemAtURL:]`을 **UI 스레드에서**.
  큰 노트 폴더를 버리면 창이 언다. `async` + `spawn_blocking`이어야 한다

> **정정 (측정, 2026-07-30 · `f8e4a8f6b`에서 수정됨).** 진단(동기 커맨드 = 메인
> 스레드)은 맞다 — `tauri-macros/src/command/wrapper.rs`가 `asyncness` 없는 fn에
> kind `"sync"`를 고른다. 하지만 **"큰 노트 폴더를 버리면 언다"는 틀렸다.**
> `os_trash.rs`의 `#[ignore]` 벤치로 재면 정상 상태의 한 번은 **0.3ms**라,
> 문서 여덟 개를 보관해도 5ms — 안 보인다.
> 진짜 비용은 프로세스의 **첫 호출**이다: 세 번 돌려 271·293·316ms, Cocoa 콜드
> 초기화. 즉 파일 개수 문제가 아니라, 세션에서 **처음** 뭔가를 지울 때 창이
> 0.3초 멈추는 문제였다. 호출 순서대로 찍어야 이 둘이 갈린다(중앙값만 보면
> "빠르다", 최댓값만 보면 "가끔 느리다"로 읽힌다).
- `reveal.rs:10`, `sound.rs:19` — 메인 스레드에서 블로킹 `std::process::Command::spawn()` (~1–5ms)
- 나머지는 진짜 싼 락 읽기이거나 AppKit이라 메인 스레드여야 한다

---

### 3-15. 감사가 놓친 것 2건 (2026-07-29 추가)

구현 중 발견. 둘 다 원 감사에 없다.

**(a) 종료 중 사이드카를 새로 띄운다 · P1** — 고침 (`5219d7239`)

`shutdown_all`이 graceful `shutdown`을 보내면 노드가 ~250ms 뒤 종료 → 이때
매니저가 아직 `Arc`를 쥐고 있어 exit 핸들러가 무장 상태 → `handle_exit` →
`restart_decision`이 500ms 백오프 → **~750ms에 새 사이드카 스폰**. `app_quit`은
700ms 후 `app.exit(0)`인데 이건 `std::process::exit`이라 `Drop`을 건너뛴다.
**여유 약 50ms.** 지면 완전히 고아가 된 사이드카가 남는다 — `shutdown_all` 주석이
고쳤다고 주장하는 바로 그 부류다. 덤으로 곧 사라질 프론트엔드에 `Restarting`
상태를 쏜다.

정석: "의도한 종료인가"를 타이밍으로 추론하지 말고 **정책의 입력으로** 받는다.
`restart_decision(shutting_down, ...)` + `RestartAction::Expected`, 플래그는
통지 **전에** 세운다(사이드카가 0.25초 만에 반응하므로). 예상된 종료는
크래시 예산도 쓰지 않는다 — 우리가 시켜서 나간 건 건강 여부에 대해 아무 정보가
없고, 예산을 쓰면 나중의 진짜 크래시가 캡에 일찍 걸린다.

**(b) `propose_*`가 모델에게 거짓 보고를 한다 · P1** — 미수정

`relay.mjs:26-30`의 `awaitVerdict`는 15초 후 fail-open하고 모델에게
*"queued for user review"*라고 답한다. **카드는 만들어진 적이 없다.** 모델은
성공한 줄 알고 넘어가고, 유저는 편집을 잃고, 어디에도 신호가 없다. 3-4의
유실이 **무음인 진짜 이유**가 이것이다.

8개 릴레이 툴 중 `query_notes`만 우연히 제대로 한다 — 5초 타임아웃 후 모델에게
보이는 오류를 반환한다(`server.mjs:206-215`). `move_note`/`set_note_status`/
`set_note_tags`/`propose_skill`은 await조차 안 하고 무조건 성공 문자열을 반환한다.

> **정정 (구현 중 확인).** 위 네 개를 한 묶음으로 적었지만 셋과 하나는 다르다.
> `set_note_status`/`set_note_tags`/`move_note`는 호스트 쪽에 **조용히 거절하는
> 경로가 실제로 있다** — 못 찾는 경로, 그리고 그 필드를 가질 수 없는 문서 타입
> (데일리·시스템 페이지는 status가 없고, 타입에서 경로가 파생되는 문서는 못
> 옮긴다). 그래서 "설정했다"가 거짓일 수 있었다. 셋 다 왕복으로 고쳤다.
>
> `propose_skill`은 그렇지 않다. 프론트 리스너의 `useSkillProposalStore.push`는
> **조건 없이** 저장하므로 *"proposed for user review"*는 참이다. 남는 위험은
> "리스너가 이미 정리된 뒤 이벤트가 도착"뿐인데, 이건 `chat/proposal`,
> `ingest/result`, `chat/task`가 전부 공유하는 채널 일반의 성질이다. 한 툴을
> 왕복으로 바꿔 그 한 인스턴스만 감지하게 만드는 것은 일반 문제를 엉뚱한
> 자리에서 막는 것이라 하지 않았다.

fail-open은 **"호스트가 멈췄을 때"** 정책으로는 맞지만 **"배달 불가능한 제안"**
에는 틀렸다. 둘은 다른 조건인데 정책을 공유하고 있다. 3-4와 함께 고쳐야 한다.

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

**0~4는 완료됐다.** 처방이 틀렸던 항목은 아래에 실제로 한 일을 적어두었다 —
각 항목의 ⚠️ 정정 블록에 근거가 있다.

| # | 할 일 | 근거 | 크기 | 상태 |
|---|---|---|---|---|
| **0** | `credential_helper_args` 잔해 삭제 → `cargo test` 컴파일 복구 (**18개** 부활, 20 아님. 선결: bun·sidecar-pkg·secrets) | §0 | 분 | ✅ `e073770d9` |
| **1** | **`derive_key`에** `OnceLock` 캐시 (**토큰은 캐시 금지**, `LazyLock` 금지) | 2-4 | ~20줄 | ✅ `f1203f28a` |
| **2** | `modelBodyBase`를 **threadId**로 키잉 (runId면 2턴째부터 CAS가 꺼짐) + 스레드 삭제 시 정리 | 3-1 | 소 | ✅ `f7a47993c` |
| **3** | ~~릴레이 getter에 `?? rec.bgTurnRunId`~~ → **불충분.** `lastRunId` + 호스트 절반이 필요하므로 **#8과 함께** | 3-4 | 중 | ⏸ 보류 |
| **4** | **`Drop`에서** `hard_kill` + `disarmed` 플래그 (`restart`에 넣으면 재시작 폭주) | 3-5 | 소 | ✅ `9e0f346a3` |
| **4b** | 종료 중 재스폰 경쟁 — `restart_decision`에 종료 게이트 | 3-15(a) | 소 | ✅ `5219d7239` |
| **5** | ~~단일 비행 마크다운 파싱 래치~~ → **적용 불가.** 아래 ⚠️ 참조 | 2-1 | — | ❌ 폐기 |
| **6** | 페이서의 **커밋**을 리빌과 분리해 속도 제한 (타이머가 아니라) | 2-1 | ~50줄 | ✅ `37d5f007a` |
| **6b** | `PartList` 구독 좁히기 (2-8 정정에서 승격) | 2-8 | 소 | ✅ `fcc596b7a` |
| **7** | `MAX_LIVE_THREADS`를 진짜 경계로 (큐 or 거부) 또는 상수 삭제 | 3-2 | 소 |
| **8** | `chat/event`를 run별 `tauri::ipc::Channel`로 + `&RawValue` 통과 | 2-2 | 중 |
| **9** | 서브에이전트 `stream_event` 드랍 (`server.mjs:1145`) | 2-3 | 극소 |
| **10** | `SidecarError`를 타입 그대로 프론트까지 | 3-11 (3-3의 선결) | 소 |
| **11** | `spawn_blocking` for §3-13 사이트, `move_to_trash` async화 | 3-13, 3-14 | 소 |
| **12** | 채팅 리스트 가상화 | 2-8 | 중 | (6b 이후 재평가) |
| **13** | 볼트 스캔/인덱스를 Rust 커맨드로 (walkdir + 병렬 frontmatter) | 2-5 | 중 |
| **14** | vault 쓰기 + git을 Rust 단일 writer 액터로 | 3-7, 3-9 | 대 |
| **15** | `PROTOCOL.md` 정정 + 계약 단일화 | §4 | 중 |
| — | 사이드카 프로세스 풀 | 8·13·14 하고도 부족할 때. **지금은 시기상조** | — |

**5·6·8이 "빠르게"의 대부분, 13·14가 "Rust 네이티브"의 대부분,
0·2·3·4가 "에러가 전혀 없어야"의 대부분이다.**

> **2026-07-29**: 0·1·2·4·4b·6·6b 완료, CI에 cargo 잡 추가(`1d230572b`).
> **5는 폐기** — 래치는 적용 불가, 블록 분할은 대가가 이득보다 크다(§2-1 ⚠️).
> 3은 #8에 병합.
>
> "빠르게"는 실측으로 해결됐다: 스트리밍 20KB가 메인스레드 73.6%(최악 261ms) →
> 13.5%(28ms), 그리고 Accept 한 번의 606ms 멈춤 → 0. 남은 렌더 비용은 **가상화(#12)
> 재평가**가 다음 후보이고, 그 전에 `handleRegenerate`의 `useCallback` 한 줄이 더 싸다.
>
> 남은 "에러가 전혀 없어야" 항목은 **3-15(b) `propose_*`의 거짓 보고** 하나이고,
> 3-4와 같은 뿌리라 #8과 함께 간다. 그 다음 무게중심은 **13·14("Rust 네이티브")** —
> 아직 손대지 않았다.

---

## 7. 한 줄 요약

구조가 의도를 배신한 게 아니라, **의도한 일을 Rust에게 준 적이 없다.**
Rust는 잘 쓰인 바이트 파이프이고, 에이전트 스케줄링·이벤트 라우팅·파일 쓰기·인덱싱은
전부 그 위 두 층(Node 이벤트 루프 하나, React 메인 스레드 하나)에 얹혀 있다.

되돌리는 데 가장 효율이 높은 단일 변경은 **8번 — Rust가 run별 이벤트 스트림을 소유하는 것**이다.
그 하나로 창 증폭, 이중 직렬화, zod-후-폐기가 동시에 사라지고,
Rust에 `runId → {thread, window, channel}` 레지스트리가 생기면서 이후 13·14의 발판이 된다.
