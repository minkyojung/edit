# 코드 품질 리뷰 — 4개 영역 통합 보고 (2026-05-13)

라벨/title 시스템 정리(직전 세션, 8개 PR) 이후, 나머지 주요 영역 4곳을 같은 방식(전문 에이전트 병렬 리뷰)으로 훑은 결과입니다.

- **편집기** (마크/제안/wikilink) — `code-reviewer`
- **동기화·저장** (collab/IndexedDB/서버) — `debugger`
- **채팅·에이전트** (스트리밍/ingest) — `react-expert`
- **사이드바·탐색** (트리/팔레트/뷰) — `refactoring-specialist`

각 에이전트는 read-only로 발견 항목만 보고. 라벨 시스템 관련 항목은 이미 정리됐으므로 제외.

---

## 1. 편집기

### 🟠 즉시 주목할 발견

#### 1-A. 외부 붙여넣기로 위험한 링크가 노트에 박힐 수 있음
다른 사이트에서 글을 복사해 노트에 붙여 넣을 때, 함께 따라온 `javascript:...` 같은 링크가 그대로 본문 mark로 들어올 수 있음. 일반 클릭 핸들러는 scheme 검증이 약함.

- 파일: `apps/writer-tauri/src/editor/wikilinkClickPlugin.ts:21-48`, `apps/writer-tauri/src/editor/linkClickPlugin.ts` (Cmd-클릭에만 검증), `apps/writer-tauri/src/editor/proofMarkSchemas.ts` (parseDOM에 검증 없음)
- 조치: paste sanitizer + link mark의 href scheme allowlist (`http`/`https`/`mailto`/`note`)

#### 1-B. 마크 accept 도중 collab 충돌이 일어나면 위치 어긋남
협업 중 다른 사람이 동시에 본문을 편집하면, accept 트랜잭션의 캐시된 position이 stale이 되어 글자가 의도하지 않은 위치에 들어갈 수 있음. 최악의 경우 dispatch 실패 → "마크 표시는 사라졌는데 Y.Map 엔트리는 남는" 비대칭 상태.

- 파일: `apps/writer-tauri/src/editor/markActions.ts:91-206`
- 조치: `ydoc.transact` 내부에서 `tr.mapping`으로 position 재해석, dispatch 결과 검증

#### 1-C. wikilink 입력 정화 누락
`[[query]]`의 query에 줄바꿈/탭/제어문자가 들어가면 `schema.text(label)`이 throw해 commit 실패. 팔레트가 닫히지만 사용자는 원인을 모름.

- 파일: `apps/writer-tauri/src/editor/wikilinkPalettePlugin.ts:176-205`
- 조치: label sanitize (`.replace(/[\n\r\t]/g, ' ').trim()`)

### 🟡 작은 잔재

| 발견 | 파일 | 영향 |
|---|---|---|
| 마크 cleanup이 microtask로 지연 → 그 사이 사용자 입력 시 undo 그룹 깨질 가능성 | `markCleanupPlugin.ts:46-50` | 낮음 |
| 빠른 close/open 시 destroyed view에 dispatch 시도 | `MilkdownEditor.tsx:93-100` | 콘솔 에러 |
| WikilinkPalette commit 도중 사용자가 doc 전환하면 stale view에 dispatch | `WikilinkPalette.tsx:225` | 낮음 |
| SlashMenu/WikilinkPalette Escape 처리 명시적 guard 없음 | `SlashMenu.tsx:103` | 낮음 |

---

## 2. 동기화·저장

### 🔴 가장 중요한 발견

#### 2-A. `ensureHandle` 동시 호출 시 핸들 두 개 생성
`if (get().handles[slug]) return` 후 `set()`까지 microtask 갭이 있음. React 18 batching/Strict Mode에서 같은 tick에 두 번 호출 가능 → **두 개의 Y.Doc + IndexeddbPersistence + WebSocket이 같은 slug로 생성**. 후자만 store에 남고 전자는 leak. CRDT는 안전하지만 자원 누수.

- 파일: `apps/writer-tauri/src/state/docsStore.ts:1050-1082` (ensureHandle)
- 조치: module-level `Map<slug, Promise>` in-flight 캐시로 동시 호출 직렬화

#### 2-B. 다른 디바이스 첫 열기 시 paragraph 중복 가능
idb 비어있고 provider sync 도착 전 MilkdownEditor가 mount되면 schema-fill로 빈 paragraph 추가 → 그 후 서버 baseline 머지 시 빈 paragraph가 살아남을 수 있음 (Y.XmlFragment 머지는 dedup 안 함). 라벨 시스템 정리 때 한쪽 race는 막았지만 이 윈도우는 별개.

- 파일: `apps/writer-tauri/src/state/docsStore.ts:174-265` (buildHandle, attachProviderWhenReady), `apps/writer-tauri/src/editor/MilkdownEditor.tsx:258-270`
- 조치: provider.synced 전까지 schema-fill 차단 플래그

### 🟠 콘솔 에러

#### 2-C. 빠른 close/open 시 destroyed 객체 접근
`closeDoc`이 `ydoc.destroy()` 호출 직후, `buildHandle`의 fire-and-forget `idb.whenSynced.then(...)`이 resolve되면 destroyed fragment에 `observeDeep` 시도 → throw. `installTitleMirror`의 listener도 destroy 후 fire 가능.

- 파일: `apps/writer-tauri/src/state/docsStore.ts:471-509` (closeDoc), `:217-265` (attachProviderWhenReady)
- 조치: destroy 전 listener/observer 명시적 off + pending then 차단 플래그

### 🟡 부수

| 발견 | 파일 | 영향 |
|---|---|---|
| `indexedDB.deleteDatabase` await 없음 — blocked 상태로 archived 콘텐츠 부활 가능 | `docsStore.ts:758, 799` | 낮음 |
| Mutation idempotency가 in-memory Map — 서버 재시작 시 소실, 멀티 인스턴스 비활성 | `proof-sdk/server/mutation-idempotency.ts:13` | 중간 (분산 환경) |
| Server snapshot S3 업로드 metric이 out-of-order 실패로 최신 성공 덮어쓸 수 있음 | `proof-sdk/server/snapshot.ts:91-119` | observability noise |
| `ingestStore`의 markEdited observer가 idb sync 첫 머지에 fire — 안 건드린 doc도 lastEditedAt 갱신 | `docsStore.ts:174-210`, `ingestStore.ts:292-301` | LLM 비용·인지 부담 |

---

## 3. 채팅·에이전트

### 🔴 가장 중요한 발견

#### 3-A. 채팅 실행 중 에디터 unmount되면 죽은 view에 dispatch
`useChatRunner.run`이 `editorView!`를 `await` 이후에도 참조. 사용자가 채팅 응답 흐르는 중에 다른 doc으로 전환하면 unmounted ProseMirror state에 `applyProposal`이 쓰려고 함.

- 파일: `apps/writer-tauri/src/chat/hooks/useChatRunner.ts:80-231`, `apps/writer-tauri/src/agent/chat.ts:505`
- 조치: ref로 capture, editorView 변경 시 활성 run abort

#### 3-B. 채팅창 unmount 시 AbortController 정리 누락
컴포넌트 unmount 시 active run이 abort되지 않음. setStreaming/setStatus가 unmounted owner에 fire.

- 파일: `apps/writer-tauri/src/chat/hooks/useChatRunner.ts:108-228`
- 조치: in-flight runId ref + useEffect cleanup에서 `abortByThread(activeId)`

#### 3-C. `useIdleTrigger` 타이머가 unmount 후 fire
타이머 firing 후 `runActiveIngest()`가 진행 중이면 unmount 후에도 `enqueue` 호출. 취소 토큰 없음.

- 파일: `apps/writer-tauri/src/hooks/useIdleTrigger.ts:341-354`
- 조치: AbortController ref + ingest fetch에 전달

### 🟠 무한 대기 가능성

#### 3-D. `awaitChatRun` 타임아웃 없음
`claude:done`/`claude:error`가 영영 안 오면 promise 영원히 대기, listener leak. 사이드카가 wedged-but-alive면 발생.

- 파일: `apps/writer-tauri/src/agent/ingest.ts:329-419`
- 조치: 90s timeout race + cleanup

### 🟡 부수

| 발견 | 파일 | 영향 |
|---|---|---|
| `useActiveThread` effect deps에 `active` 배열 — upstream 매번 새 ref면 매 render fire | `useActiveThread.ts:55-64` | 미세한 re-render |
| Tool call out-of-order 시 첫 tool이 영원히 spinning으로 보일 수 있음 | `chat.ts:345-484` | 드문 케이스 |
| `chat.ts` cleanup race — `controller.signal.aborted` 후에도 `.then`이 unlistens push | `chat.ts:558-562` | leak 가능 |
| `__triggerIdle()` (dev console)이 `runningRef` 우회 → 동일 doc 동시 ingest 가능 | `useIdleTrigger.ts:389-391` | dev-only |

---

## 4. 사이드바·탐색

### 🟠 구조 정리 가치 큼

#### 4-A. 같은 doc 필터/정렬 로직 4–5군데 복붙
- `DayView.tsx:64`, `WeekView.tsx:63`: `!archivedAt && !isWikiDoc(d)` 동일
- `WikilinkPalette.tsx:72` (type 무관), `UnlinkedNotes.tsx:64` (type='writing'만) → **결과 어긋남 가능**
- `DocTreeNode.tsx:191` (slug 정렬), `ArchivedDocsPopover.tsx:54` (archivedAt desc) → 정렬 정책 분산
- 조치: `selectLiveWritingDocs()` / `useChildDocs(parent, opts)` 셀렉터 통합

#### 4-B. CommandPalette ↔ WikilinkPalette 후보 불일치
같은 doc인데 한쪽엔 검색되고 한쪽엔 안 나오는 일관성 어긋남.
- CommandPalette: `liveDocs = !archivedAt` (모든 타입 포함), haystack은 `date+label` 또는 `title ?? ''`
- WikilinkPalette: 부모 children만, `titleFor(doc)` (live label 우선)
- 조치: 양쪽 모두 `useDocLabel` 기반 후보 빌더로 통일

#### 4-C. `wikiService.ensureXxxWikiSlug` 4벌 거의 동일
`ensureLogWikiSlug` / `ensureConventionsWikiSlug` / `ensureIndexWikiSlug` / `createCustomWikiPage` — `find → existing return → generateClientSlug → setState → createDoc.catch` 패턴 완전 동일.
- 파일: `apps/writer-tauri/src/state/wikiService.ts:82/104/130/197`
- 조치: `ensureSystemDoc({type, title, body})` 헬퍼로 1개

### 🟡 부수

| 발견 | 파일 | 영향 |
|---|---|---|
| `ensureNotesRoute` 5벌 복붙 | DayView/WeekView/MonthView/WikiSection/Sidebar | 유지보수 부담 |
| `dailyByDate` Map 빌드 중복 | WeekView/MonthView | 유지보수 |
| ZWS 시드 잔재 (log/index가 `'​'` 전달) | `wikiService.ts:94/140/207/241` | dead code 가능 |
| `expandedDocSlugs`가 배열 includes (O(n)) | `DocTreeNode.tsx:68` | 깊은 트리에서 미세 |
| `useDocAncestry`가 매 호출마다 `bySlug` Map 재구축 | `useDocAncestry.ts:30` | 같은 페이지에 N×O(docs) |

---

# 통합 우선순위

## 🔴 즉시 조치 (사용자 체감 위험 / 보안 / 자원 누수)

| # | 항목 | 영역 | 왜 |
|---|---|---|---|
| 1 | `ensureHandle` 동시 호출 가드 | 동기화 | Y.Doc + WebSocket 두 개 생성, 자원 누수 |
| 2 | 채팅 cleanup — AbortController + unmount 가드 | 채팅 | 죽은 객체에 setState, 데드 view에 dispatch |
| 3 | paste 시 위험한 link href 차단 + scheme allowlist | 편집기 | XSS 표면 |
| 4 | 다른 디바이스 첫 열기 paragraph 중복 가드 | 동기화 | 사용자 체감 데이터 변형 |
| 5 | 마크 accept 트랜잭션 collab 안전성 | 편집기 | 협업 중 글자 위치 어긋남 |

## 🟠 다음 단계 (구조 개선)

| # | 항목 | 영역 |
|---|---|---|
| 6 | `wikiService` 4벌 → `ensureSystemDoc` 헬퍼 1개 | 사이드바 |
| 7 | `selectLiveWritingDocs` / `useChildDocs` 셀렉터 통합 | 사이드바 |
| 8 | CommandPalette ↔ WikilinkPalette 후보 빌더 통일 | 사이드바 |
| 9 | close/open 빠른 토글의 destroyed 객체 보호 | 동기화 |
| 10 | `useIdleTrigger` AbortController + 취소 토큰 | 채팅 |

## 🟡 작은 잔재 (선택)

| # | 항목 | 영역 |
|---|---|---|
| 11 | `awaitChatRun` 타임아웃 추가 | 채팅 |
| 12 | wikilink label 입력 정화 | 편집기 |
| 13 | `wikiService`의 ZWS 시드 잔재 정리 | 사이드바 |
| 14 | `indexedDB.deleteDatabase` await | 동기화 |
| 15 | `ensureNotesRoute` 5벌 → 1훅 | 사이드바 |
| 16 | `expandedDocSlugs`를 Set으로 | 사이드바 |
| 17 | `useDocAncestry` `bySlug` 메모이즈 | 사이드바 |

---

# 진행 방식

라벨 시스템 정리와 동일 패턴:
1. 사용자가 우선순위에서 한 항목 선택
2. 영향 파일 확인 → 정공법 수정안 설계 → 사용자 합의
3. 구현 → type-check + lint → 사용자 시각 검증 → 커밋·푸시
4. 다음 항목으로

🔴 부터 차근차근 가는 것이 사용자 정책("Reliable, Well-made, 에러 0")에 부합. 17개 모두 다 할 필요는 없고, 🔴 5개 + 🟠 일부 정도면 충분합니다.
