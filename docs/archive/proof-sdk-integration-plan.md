# proof-sdk 통합 계획

> **[SUPERSEDED — 2026-04-30]**
> 이 문서는 Path A (ProofEditorImpl 직접 임베드) 실행 계획이다. Path A는 폐기됨.
> 결정 배경: `docs/adr/2026-04-30-path-b-rewrite.md`
> 현재 방향: Path B — Milkdown 직접 구축 + proof-sdk는 HTTP API만 사용. 실행 계획: `docs/path-b-rewrite-plan.md`

작성: 2026-04-29
브랜치: minkyojung/shadcn-luma-plan
업데이트: 2026-04-30 — Step 1~4 + (수동 trigger로 변경된) Step 5 일부 완료. 자세한 결정 기록은 `proof-sdk-integration-notes.md`.

> **현재 상태**: Step 1~4 완료, ⌘⇧C 수동 trigger 도입 후 검증됨. 통합 자체는 작동. 남은 작업은 정리/UX 다듬기.

---

## 1. 배경 — 왜 이 작업을 하나

### 발생한 문제
지난 며칠 동안 우리 자체 mark 시스템 (markPlugin.ts + Y.Map sidecar + HTTP accept/reject) 으로 다음 버그를 잡으려 했음:

1. 공백 잡아먹힘 + 무한 루프
2. bulk accept 후 Tab 동작 불가
3. trailing 공백 잔존

분석 결과: **우리 클라가 텍스트 변경을 적용하고, 서버도 같은 변경을 자기 식으로 적용** → 두 결과가 Yjs 로 충돌. 근본 원인은 proof-sdk 의 mark 모델 (인라인 ProseMirror 마크) 과 우리 모델 (Y.Map sidecar + decoration) 이 본질적으로 다름.

### 결정한 방향
**proof-sdk reference editor 를 그대로 받쳐오고, 그 위에 우리 부분 (Claude SDK, OAuth) 만 얹는다.** patch-on-patch 멈추고 검증된 구조로 정렬.

---

## 2. 채택한 길 — Path 2 (=ProofEditor 의 editor 부분만 활용)

### 검토했지만 안 채택한 옵션
- **순수 ProofEditor 통째**: 자동 init / DOM id 'editor' / share-mode 자동 흐름 등 우리 Electron 환경과 안 맞음. fork 통째 수정 필요해 시간 큼
- **share mode 흐름 포팅**: share mode 는 멀티 유저 웹 SaaS 가정. 우리는 단일 유저 desktop 앱. 의미 없음

### 채택한 형태
```
[App.tsx]                                    ← 우리 코드 유지
  ├─ ydoc (Y.Doc)                            ← 우리 코드 유지
  ├─ HocuspocusProvider                      ← 우리 코드 유지 (서버 연결)
  └─ MilkdownEditor.tsx                      ← 재작성
       └─ new ProofEditorImpl()              ← proof-sdk 의 editor + plugin 25개
            └─ collabService.bindDoc(ydoc)   ← 우리 ydoc 을 ProofEditor 의 milkdown 에 연결

[main process]
  ├─ Claude SDK / agentService               ← 우리 코드 유지
  ├─ OAuth / oauthService                    ← 우리 코드 유지
  └─ proof-server (spawned)                  ← proof-sdk 의 서버 그대로

[추가 필요]
  ├─ HTTP polling 으로 마크 sync (share-marks-refresh 단순화)
  └─ accept/reject HTTP wrapper (markService 부활)
```

핵심: **proof-sdk 의 에디터 + 마크 plugin 은 가져오되, 서버 연결과 우리 시스템 (Claude, OAuth) 은 우리 거 유지**.

---

## 3. 현재 준비된 것

✅ proof-sdk fork 완료 — `github:minkyojung/proof-sdk`
✅ 로컬 clone — `~/conductor/workspaces/edit/proof-sdk/`
✅ branch — `zurich-customizations`
✅ upstream remote 등록 — 향후 보안 패치 받기용
✅ live link — `zurich/package.json` 의 `proof-sdk: link:../proof-sdk`
✅ fork 수정 3가지 (commit `302dfd7`):
  - `ProofEditorImpl` 클래스 export
  - `init(rootElement?)` 옵션 추가
  - 자동 init 비활성화

---

## 4. 작업 단계

### Step 1 — `MilkdownEditor.tsx` 재작성 ✅
**시간**: 30~60분
**파일**: `apps/writer/src/renderer/src/MilkdownEditor.tsx`

- `Editor.make()...use()` 체인 모두 제거
- `new ProofEditorImpl()` 인스턴스 생성
- `proof.init(rootRef.current)` 호출
- 우리 ydoc 을 ProofEditor 의 milkdown collab service 에 bindDoc
- 정리 시 disconnect

**검증**: 빌드 통과. dev 띄워서 빈 에디터 정상 표시. 콘솔 에러 없음.

### Step 2 — HTTP polling 으로 마크 sync 추가 ✅
**시간**: 1시간
**파일**: 새로 만듦 — `apps/writer/src/renderer/src/marksRefresh.ts` 또는 `MilkdownEditor.tsx` 안에

- 1~2초 간격으로 proof-server `/api/agent/<slug>/state` 호출
- 응답 `doc.marks` 추출
- `applyRemoteMarks(view, marks)` 호출 → 인라인 ProseMirror 마크로 변환
- mount 시 시작, unmount 시 정리

**검증**: 글 입력 → 1.5초 후 Claude 가 mark 만듦 → 1~2초 안에 화면에 빨간 strikethrough/초록 underline 등 표시됨. `document.querySelectorAll('[data-proof="suggestion"]')` 가 entry 가져옴.

### Step 3 — accept/reject HTTP wrapper 복구 ✅
**시간**: 1시간
**파일**: 새로 만듦 — `apps/writer/src/main/markService.ts` (step 1 에서 삭제했던 것 비슷한 형태)
**파일**: `apps/writer/src/preload/index.ts` (window.marks 채널 복구)

- `accept(markId)`, `reject(markId)` 함수
- `POST /api/agent/<slug>/marks/accept` (또는 reject)
- `proofClient.withMutationBaseRetry` 로 mutation base 처리

**검증**: Tab 누름 → 서버에 accept 도달 → 서버가 mark 처리 (canonical markdown 변경) → polling 으로 marks 갱신 → 화면에서 mark 사라지고 텍스트 변경.

### Step 4 — Tab/Esc 핸들러 추가 ✅
**시간**: 30분
**파일**: `MilkdownEditor.tsx` 내

- ProofEditor 의 `accept(view, markId)` / `reject(view, markId)` 함수 직접 호출 — 클라 측 PM 변경
- HTTP wrapper 도 같이 호출 — 서버 동기화
- 키바인딩: Tab → focused mark accept, Esc → reject, ⇧⌘A → acceptAll

**검증**: 시나리오 6개 (공백/벌크/trailing/proofAuthored/Esc/연타) 모두 정상.

### Step 5 — 정리 + commit (진행 중)

✅ 완료
- 디버그 헬퍼 정리 (`[emit] / [poll] / [ydoc.update] / [pm.dispatch]` 로그, `window.__ydoc` expose 제거)
- 자동 trigger → ⌘⇧C 수동 trigger로 변경 (사용자 통제권 + 토큰 절약)
- 통합 노트 작성: `docs/proof-sdk-integration-notes.md`
- step별 commit + push 완료

🔲 남은 정리 거리
- 시각 토큰 — 마크 색상이 proof-sdk 기본값. 우리 디자인 token 매칭은 별도 작업
- (옵션) `link:` 모드 → GitHub URL 모드 전환 (안정화 후)
- `view.dispatch` wrap을 ProseMirror Plugin으로 대체 (정공법화)
- ydoc origin 필터링 (AI 실시간 협업 들어가기 전 필수)
- ANCHOR_NOT_FOUND race 대응 (server-confirmed 신호 대기)

---

## 5. 검증 시나리오 (Step 4 끝에서 모두 통과해야 함)

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | "그는 정말로 매우 빠르게 달렸다" 입력 → Tab 으로 수락 | 텍스트 깔끔, 무한 루프 없음 |
| 2 | 다단락 입력 → 5개 정도 마크 → ⇧⌘A | 모두 처리, 후속 Tab 정상 |
| 3 | replace/delete 수락 후 텍스트 양쪽 공백 | 1칸씩, stray 공백 없음 |
| 4 | AI 가 추가/대체한 텍스트 시각 표시 | 옅은 배경 (proofAuthored) |
| 5 | Esc 거절 + Tab 다음 마크 이동 | 정상 |
| 6 | Tab 빠른 연타 | 모든 마크 정상 처리 |

---

## 6. 위험 + 대응

| 위험 | 가능성 | 대응 |
|---|---|---|
| ProofEditor 의 milkdown collab 이 우리 외부 ydoc 과 호환 안 됨 | 중 | bindDoc 직접 호출 — 작동 안 하면 fork 수정 추가 |
| ProofEditor 의 자체 collabClient 가 부재 시 일부 plugin 이 fail | 중 | mark plugin 은 collabClient 직접 안 쓴다 확인됨. 다른 plugin 도 검증 필요 |
| HTTP polling 1~2초 간격이 사용자에게 느려 보임 | 낮 | 1초로 시작, 필요시 빈도 조정 |
| accept 가 서버 reject (rehydration 실패 등) | 중 | 옛 버그 — proof-sdk reference 의 acceptMark 가 정식 routing 함. 우리 client 는 그대로 통과 |
| ProofEditor 의 다른 의존성 (heatmap, agent-cursor 등) 이 우리 환경에서 throw | 낮~중 | 발견되는 대로 fork 에서 conditional skip 추가 |
| GitHub URL 모드 전환 후 path 가 안 풀림 | 낮 | 안정화 후만 전환. 문제 시 link: 로 복귀 |

---

## 7. 명시적 비범위 (이번에 안 함)

- share mode (멀티 유저 동시 편집 / 링크 share)
- agent presence (Claude 가 cursor 표시)
- mermaid / frontmatter / find-highlights 등 ProofEditor plugin — 들어오지만 우리가 신경 안 씀
- 향후 fork upstream 머지 자동화
- 디자인 / 시각 토큰 통합 (Step 5 이후 별도)

---

## 8. 진행 원칙

1. **단계마다 commit** (위와 같이 step 1~5 각각)
2. **단계 검증 통과 못 하면 다음 단계 안 감**
3. **빌드 통과 ≠ 동작 검증** — 매 step dev 띄워 확인
4. **막히면 fork 코드 다시 읽기** (추측 금지)
5. **새 가설 → 즉시 검증** (patch-on-patch 회피)

---

## 9. 다음 액션

기본 통합은 완료. 남은 작업:

1. **시각 토큰 매칭** — 우리 design system에 맞춘 마크 색상
2. **PM Plugin 전환** — `view.dispatch` wrap → 정공법
3. **AI 실시간 협업 준비** — origin filter + server-sync 대기

자세한 결정 기록과 디버그 팁은 `docs/proof-sdk-integration-notes.md` 참고.
