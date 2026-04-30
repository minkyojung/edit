# proof-sdk 통합 — 배운 것들

작성: 2026-04-30
대상 브랜치: `minkyojung/proof-sdk-milkdown-rewrite`
관련: `docs/proof-sdk-integration-plan.md` (원래 계획)

이 문서는 proof-sdk를 우리 Electron 앱에 끼워넣으면서 마주친 환경 특수성과 그에 대한 결정 기록이다. 다음에 이 영역을 만질 때 참고용.

---

## 1. 아키텍처 한 눈에

```
[App.tsx]                           ← 우리 코드
  ├─ ydoc (Y.Doc)
  ├─ HocuspocusProvider              ← 항상 켜둠 (proof-server 동기화)
  └─ MilkdownEditor.tsx
       └─ ProofEditorImpl()           ← proof-sdk 그대로
            └─ collabService.bindDoc(ydoc)

[main process]
  ├─ agentService                    ← Claude SDK
  ├─ docService                      ← 슬러그/토큰 부트스트랩
  ├─ markService                     ← /api/agent/<slug>/state 폴링,
  │                                    accept/reject HTTP wrapper
  └─ proof-server (spawned)          ← proof-sdk의 서버
```

핵심 결정: **renderer는 proof-server에 직접 fetch하지 않고 main IPC를 통한다.** 이유는 §3 참조.

---

## 2. proof-sdk 의존성 — 정공법

처음에 symlink 6개 만들고 NODE_PATH 추가하는 우회를 시도했다가 prosemirror-model 중복 인스턴스 충돌이 발생했다. 결국 다음으로 정리:

- `proof-sdk/` 안에서 자체 `pnpm install`을 돌려 자기 `node_modules` 완비
- 서버가 직접 import하는 transitive 의존성을 proof-sdk `package.json`에 **명시적으로 추가**:
  - `@milkdown/prose`, `@milkdown/transformer`
  - `remark-parse`, `remark-stringify`, `unified`
  - `y-protocols`, `lib0`
- `pnpm.onlyBuiltDependencies`에 `better-sqlite3`, `@resvg/resvg-js` 추가 → native 모듈 자동 빌드

**교훈**: pnpm의 strict hoisting 탓에 transitive 의존성은 top-level에서 안 보인다. 서버가 bare import 하는 패키지는 무조건 명시.

---

## 3. CORS — 무조건 main process 경유

renderer는 vite dev에서 `localhost:5174`에 떠있고 proof-server는 `localhost:4000`. cross-origin이라 fetch 차단됨. 더 중요한 건 **production 빌드(`file://`)에서도 동일하게 차단됨**.

→ `markService.ts`에서 모든 HTTP 호출을 처리, 렌더러는 `window.marks.fetchState()` / `accept()` / `reject()` IPC만 사용. dev/prod 둘 다 동작.

이게 Electron 앱의 표준 패턴. 향후 외부 HTTP 호출 추가할 때 항상 이 경로.

---

## 4. milkdown listener + Yjs collab — 중요한 함정

### 증상

사용자가 글을 써도 우리 코드가 변화를 감지 못함. `markdownUpdated` 콜백이 fire 안 됨.

### 원인

두 라이브러리의 정책 충돌:

- **y-prosemirror** (`sync-plugin.js:354`): collab 환경에서 사용자 입력 transaction에 자동으로 `tr.setMeta('addToHistory', false)` 라벨을 붙임. 다른 사람의 collab 변경이 본인 undo 히스토리를 오염하지 않게 하려는 설계.
- **@milkdown/plugin-listener** (`index.js:122`): `tr.getMeta('addToHistory') === false`인 transaction은 listener 콜백을 fire하지 않음.

= **collab을 항상 켜둔 환경에선 milkdown listener가 영영 fire되지 않음.**

### proof-sdk reference editor도 같은 문제

reference editor는 single-user mode에서 collab 없이 작동하므로 이 충돌을 안 만남. share mode를 켜면 그들도 똑같이 listener가 죽지만 그들은 listener에 핵심 로직이 의존하지 않음 (별도 path로 처리).

→ **우리 환경(Electron + 항상 collab)에서 proof-sdk의 reference 패턴을 그대로 따라할 수 없음.**

### 우회 방법 (`MilkdownEditor.tsx`)

milkdown listener 안 쓰고 두 채널로 직접 청취:

```ts
// 1. Yjs ydoc 직접 청취 (source of truth)
ydoc.on('update', () => scheduleEmit())

// 2. PM dispatch 직접 wrap (fallback)
const origDispatch = view.dispatch.bind(view)
view.dispatch = (tr) => {
  origDispatch(tr)
  if (tr.docChanged) scheduleEmit()
}
```

200ms 디바운스 후 markdown 직렬화 → `onMarkdownChange`. 두 채널 다 두는 건 안전망.

---

## 5. 마크 동기화 — HTTP polling

### 패턴

```
main: setInterval 1.5초마다
  → fetch('/api/agent/<slug>/state', { 'x-share-token': ... })
  → IPC로 renderer에 result 전달
renderer: window.marks.fetchState() →
  applyRemoteMarks(view, marks)
```

`applyRemoteMarks`는 proof-sdk가 export. quote 기반 anchor hydration이 기본 활성. 우리는 그냥 호출만 하면 됨.

### 잘 되는 건 검증됨

- 서버에 마크 N개 들어가면 1.5초 안에 화면에 표시
- `authored` 마크와 suggestion 마크 모두 처리

---

## 6. accept/reject — Optimistic + HTTP 이중 호출

proof-sdk reference editor의 `markAccept` 패턴을 그대로 미러링.

### 흐름 (Tab 키 누름 시)

```ts
// 1. 즉시 (sync) — 화면 변경
acceptLocal(view, markId, parser)

// 2. 백그라운드 (async, fire-and-forget) — 서버 동기화
window.marks.accept(markId).catch(...)
```

**왜 두 번?** UX와 안정성 둘 다 잡기 위해.

- 1만 하면 → 서버 모름, 다른 클라이언트가 못 봄
- 2만 하면 → 1.5초 폴링 기다려야 화면 변경 (느림)
- 둘 다 → 즉시 반응 + 영속적 동기화

### Mutation base — 한 번에 하나만

`POST /api/agent/<slug>/marks/accept`의 body에는 `markId`, `by` 외에 mutation base가 필요한데, **`baseToken` / `baseRevision` / `baseUpdatedAt` 중 하나만 보내야 함**. 셋 다 보내면 서버가 `CONFLICTING_BASE`로 거부.

`markService.ts`의 `deriveBase()`가 우선순위 (token > revision > updatedAt)로 하나만 선택. 409 STALE_BASE 받으면 fresh state 다시 가져와서 재시도 1회.

---

## 7. Agent trigger — 수동 (⌘⇧C)

처음에는 1.5초 디바운스로 자동 trigger했지만 다음 이유로 수동으로 전환:

- AI가 언제 끼어들지 예측 불가 → 사용자가 통제권 잃음
- 입력 도중 마크가 떴다가 사라졌다 함 → 시각적 노이즈
- 토큰 낭비
- "잠깐 생각 중"과 "다 썼음"을 timer로 구분 불가

### 현재 키바인딩 (`MilkdownEditor.tsx`)

| 키 | 동작 |
|---|---|
| **⌘⇧C / ⌃⇧C** | 현재 문서를 agent에게 검토 요청 |
| **Tab** | focused 마크 수락 (없으면 기본 Tab) |
| **Esc** | focused 마크 거절 (없으면 기본 Esc) |
| **⇧⌘A / ⇧⌃A** | 모든 actionable 마크 일괄 수락 |

자동 trigger는 `App.tsx`에 주석으로 남겨둠. 나중에 ambient 모드 다시 원하면 주석 해제.

---

## 8. 알려진 거친 부분 (장기 정리 필요)

### a. PM dispatch wrap이 hacky

```ts
view.dispatch = (tr) => { origDispatch(tr); if (tr.docChanged) scheduleEmit() }
```

milkdown이 view를 재구성하면 wrap 사라짐. 정공법은 ProseMirror Plugin으로 `state.apply` hook 거는 것:

```ts
new Plugin({
  view: () => ({
    update: (view, prevState) => {
      if (!view.state.doc.eq(prevState.doc)) scheduleEmit()
    }
  })
})
// → milkdown의 prosePluginsCtx에 추가
```

지금 동작하니 일단 두지만, AI 실시간 협업 들어가기 전에 정리하는 게 좋음.

### b. ydoc origin 필터링 없음

`ydoc.on('update', (_, origin) => ...)`에서 origin 안 봄. 현재는 모든 update에 반응.

origin은 두 종류:
- `PluginKey` → 사용자 본인 입력
- `HocuspocusProvider` → 서버에서 받은 변경 (다른 클라이언트 / AI)

**AI 실시간 협업 들어가면**: AI 변경 → ydoc update → scheduleEmit → debouncer → AI를 또 trigger → 무한 루프 위험. 1.5초 디바운스가 운 좋게 막고 있지만 안전망 없음.

수정할 때:
```ts
ydoc.on('update', (_update, origin) => {
  if (origin instanceof HocuspocusProvider) return  // 외부 변경 무시
  scheduleEmit()
})
```

### c. ANCHOR_NOT_FOUND race

agent가 trigger되는 시점에 Yjs → proof-server 동기화가 아직 안 끝났을 수 있음. 그러면 Claude가 본 텍스트와 server canonical이 달라 server가 거부.

지금은 가끔 발생, 사용자가 다시 ⌘⇧C 누르면 해결. AI 실시간 협업으로 가기 전에 trigger 직전에 server-confirmed 신호를 기다리는 로직 필요.

---

## 9. 디버그 팁

### 마크 상태 빠른 확인 (DevTools 콘솔)

```js
// 현재 모든 마크
const s = await window.marks.fetchState()
console.log(s.marks)

// suggestion 마크만
Object.entries(s.marks).filter(([id]) => !id.startsWith('authored'))

// 첫 번째 actionable 마크 수락
const id = Object.keys(s.marks).find(k => !k.startsWith('authored'))
await window.marks.accept(id)

// 에디터 PM doc 확인
window.__editorView.state.doc.textContent

// ydoc 직접 확인 (디버그 모드일 때)
window.__ydoc
```

### 흐름 로그 켜기

`MilkdownEditor.tsx`의 `[emit]`, `[poll]`, `[ydoc.update]`, `[pm.dispatch]` 로그는 디버깅용. 정리되면 제거 또는 환경변수로 toggle.

### "왜 마크가 안 떠?" 진단 순서

1. **터미널** — `[agent] session started` + `[suggest_*]` 떴는지
2. **renderer console** — `[poll] fetched marks count=` 0이 아닌지
3. **renderer console** — `[poll] applied. doc has marks at positions:` 비어있지 않은지
4. 1번 안 뜸 → agent.trigger 안 됨 (수동 trigger 안 했거나 markdown 비어있음)
5. 1번 뜨고 `failed: ANCHOR_NOT_FOUND` → race, 다시 trigger
6. 2번 0 → polling 또는 markService 문제
7. 3번 비어있음 → applyRemoteMarks가 anchor 못 잡음 (quote 매칭 실패)

---

## 10. 환경 특이사항

### EADDRINUSE :::4000 (non-fatal)

```
[proof-server] [server] WebSocketServer error (non-fatal): Error: listen EADDRINUSE
```

proof-sdk 서버는 `COLLAB_EMBEDDED_WS=true`로 띄움. embedded WS가 main HTTP 서버 포트(4000)를 공유하므로 별도 WS 서버 binding 시도는 실패가 정상. proof-sdk 코드가 `(non-fatal)`로 마킹. **무시.**

### 새 doc 매번 생성

`apps/writer/src/main/docService.ts`가 앱 시작마다 새 슬러그 만듦 (ex: `gbigo97q`, `vdqxlliw`...). 같은 doc 재사용은 `userData/doc.json`에 creds 저장 후 `isAlive()` 통과 시. 디버깅 중에 강제로 새 doc 만들고 싶으면 그 파일 삭제.

---

## 11. 참고 위치

- 통합 계획 (배경 + 의도): `docs/proof-sdk-integration-plan.md`
- 메인 코드:
  - `apps/writer/src/renderer/src/MilkdownEditor.tsx` — ProofEditorImpl 마운트, 키바인딩, polling, listener 우회
  - `apps/writer/src/main/markService.ts` — fetchState, acceptMark, rejectMark, mutation base
  - `apps/writer/src/main/index.ts` — IPC 핸들러
  - `apps/writer/src/preload/index.ts` — `window.marks` 노출
  - `apps/writer/electron.vite.config.ts` — proof-sdk 의존성 alias, stub
- proof-sdk fork: `~/conductor/workspaces/edit/proof-sdk/`
  - 우리 변경: `package.json`만 수정 (deps 추가 + onlyBuiltDependencies)
  - 브랜치: `zurich-customizations`
