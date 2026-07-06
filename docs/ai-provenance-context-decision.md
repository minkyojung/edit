# AI 출처(provenance) context — 방향 결정

작성: 2026-07-06

> **상태: 보류 (2026-07-06)** — 에디터 blame UI(하이라이트/hover/offset 배선)와 `git_blame_file`은
> 걷어냄. **auto-commit + 커밋 메시지(reason 포함)만 유지** — 출처 데이터는 이걸로 이미 git에 쌓이므로,
> AI-context 회수(온디맨드 조회)는 회수 패턴을 더 조사한 뒤 구현한다. 이 문서는 그 결정의 근거 기록.

## 한 줄 요약

문장 출처("이 줄 누가 왜 썼나")는 **사람이 보는 UI가 아니라 AI가 필요할 때 꺼내 읽는
context**로 설계한다. 그 context는 **git에 풍부하게 남기고 window에는 넣지 않으며**,
에이전트가 `git blame/log/show`로 **온디맨드 회수**한다.

## 배경 — 왜 이 논의가 나왔나

- 에디터에 git blame 기반 per-line 출처 표시(누가/왜)를 붙였다: `cmAttribution.ts`,
  frontmatter offset 배선, AI 줄 배경색 하이라이트, hover 툴팁.
- 실사용 관점: **이걸 사람이 줄마다 눈으로 보는 건 의미가 약하다.** 진짜 의도는
  "AI가 편집할 때 이 출처를 읽을 수 있게 하는 것" — AI에게 context를 많이 남겨주는 것.
- 그래서 질문: 이 관점(출처 = AI용 context)이 **기술적으로 가능한가**, 그리고
  앤트로픽 엔지니어라면 어떻게 하라고 할까.

## 기술적 결론 — 이미 가능하다 (코드 거의 0)

출처는 UI가 아니라 **git 데이터**다. 세 조각이 이미 다 있다:

1. **"왜(reason)"** → propose_edit/propose_write의 `reason`이 commit body로 들어감
   (이번 세션 배선: `pendingChangesApplier.commitGroup`이 accept들의 reason을 bullet로 묶어
   커밋 본문에 기록).
2. **"누가/어느 줄"** → `git blame`이 줄 → 커밋(sha·author·subject) 연결.
   AI 커밋은 `^[a-z]+\(ai\)` subject로 구분.
3. **에이전트의 접근 수단** → 채팅 에이전트 툴셋에 **Bash** 포함
   (`['Read','Glob','Grep','Bash']` 또는 `claude_code` preset), `cwd = vaultPath`,
   볼트는 git repo. → 지금 당장 `git blame <파일>` → `git show <sha>`로 출처를 읽을 수 있다.

즉 **새 MCP 툴도, 새 배관도 필요 없다.** 필요한 건 코드가 아니라 프레임(언제 읽을지 알려주기).

## 앤트로픽식 관점 — "많이 남기고 싶다"의 올바른 형태

본능("AI에게 context를 많이 남기자")은 방향은 맞지만 메커니즘은 뒤집어야 한다.

### context rot — 많을수록 나빠진다
토큰이 늘수록 모델의 주의·회수 능력은 **열화**된다. context는 무한 자원이 아니라
점점 나빠지는 유한 자원. 목표는 "최대한 많이"가 아니라:

> **신호 강한 최소 세트만 window에 두고, 나머지는 전부 "필요할 때 꺼내 읽게" 만든다.**

### push 하지 말고 pull 하게
- **환경(파일시스템·git)을 외부 기억으로 쓴다.** window 밖에 두고 도구로 조회.
- **just-in-time 회수** — 미리 프롬프트에 다 넣지 말고, 에이전트가 필요한 순간
  `git blame`/Read/Grep으로 당겨오게 한다.
- 우리는 이미 이 이상적 세팅을 갖고 있다: git = 영속 외부기억, Bash = 회수 수단,
  reason→commit body = 회수 시 신호 강한 context.

## 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| reason → commit body | **유지·투자** | AI가 읽는 회수형 context의 핵심. 커밋 메시지를 신호 강하게 남기는 게 "context를 많이 남긴다"의 올바른 형태 |
| CLAUDE.md 포인터 | **추가** | "출처는 git으로 조회 가능. 유저가 의도적으로 쓴 줄을 덮기 전 확인" 한두 줄 |
| 에디터 blame 하이라이트 / offset 배선 / hover | **AI context로선 불필요 → 제거 후보** | 사람이 줄마다 보지 않음. AI는 git으로 직접 읽음 |

에디터 UI를 사람용으로 남길지는 **별개 질문**(제품 신호로서 가치가 있으면 유지). AI context
관점에서는 애초에 필요 없었다.

## 3층 context 모델 (기존 시스템에 대입)

- **항상 켜짐 (작게)**: CLAUDE.md + profile — 휴리스틱·정체성
- **회수형 (크게, 온디맨드)**: wiki 노트 + **git 히스토리/reason** ← 출처는 여기
- **제안형 메모리**: 학습된 사실 (proposal 기반)

출처는 **회수형**에 속한다. window에 상주시키지 않는다.

## 열린 질문 — CLAUDE.md 문구를 정하는 용도

AI가 출처를 **언제·왜** 읽길 원하는가:
- **유저 문장 보호** — 덮어쓰기 전 blame 확인, 유저가 쓴 건 함부로 안 고침?
- **연속성** — 내가 예전에 왜 이렇게 썼는지 확인하고 이어감?
- **둘 다?**

이 용도가 정해지면 CLAUDE.md 한 줄로 표현하고, 에디터 blame UI(cmAttribution + offset 배선)는
되돌린다.

## 관련 코드

- `sidecar/src/server.mjs` — 에이전트 툴셋(Bash 포함), `propose_*`의 reason 인자
- `src/state/pendingChangesApplier.ts` — `commitGroup`이 reason을 commit body로
- `src/editor/cmAttribution.ts` — (제거 후보) 사람용 blame 하이라이트/hover
- `src/state/docsStore/handlesSlice.ts` — (제거 후보) `bodyLineOffset` frontmatter 배선
- `src-tauri/src/git.rs` — `git_blame_file` (AI가 안 쓰면 불필요)
