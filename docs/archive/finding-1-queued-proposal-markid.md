# Finding 1: 큐에 쌓인 propose_change가 markId 매칭을 망가뜨림

## 위치

`apps/writer-tauri/src/agent/chat.ts:592` 근처 (`if (outcome.ok)` 블록)

관련 파일:
- `apps/writer-tauri/src/agent/chat.ts` — proposal 리스너, `findPendingProposalPart`
- `apps/writer-tauri/src/agent/applyProposal.ts` — markId 발급 지점
- `apps/writer-tauri/src/state/pendingProposalsStore.ts` — 큐
- `apps/writer-tauri/src/editor/MilkdownEditor.tsx` — 마운트 시 큐 드레인

## 한 줄 요약

탭 전환 중에 도착한 제안은 큐로 들어가는데, 이때 채팅 ToolPart에 `markId`가 안 박혀서 (1) 클릭이 죽거나 (2) 다음 제안의 `markId`가 엉뚱한 스텝에 박힌다.

## 기능 의도

이번 PR은 채팅 패널의 `propose_change` 스텝을 **클릭하면 에디터에서 해당 마크로 점프**하는 기능을 추가한다. 이를 위해 채팅의 `ToolPart`에 마크 식별자(`markId`)가 박혀 있어야 한다.

## 정상 동작 흐름

1. 모델이 `propose_change` 호출 → 채팅에 `ToolPart` 생성 (markId 없음)
2. 사이드카가 `claude:proposal` 이벤트 발행
3. `applyProposal`이 에디터에 마크 찍고 `{ ok: true, markId }` 반환
4. **`if (outcome.ok)` 블록이 `ToolPart`에 `markId` 스탬프** ← 핵심
5. 사용자가 채팅 스텝 클릭 → `markId`로 점프

## 문제가 터지는 흐름

채팅 대상 문서 A를 보다가 **다른 탭으로 이동한 사이**에 제안이 오면:

- `liveView`가 없어서 마크를 즉시 못 찍고 큐(`pendingProposals`)에 enqueue
- `outcome = { ok: false, reason: 'queued' }`
- `if (outcome.ok)` 통과 못 함 → **`ToolPart`에 `markId`가 안 박힘**
- 나중에 사용자가 A로 돌아오면 `MilkdownEditor`가 큐를 비우면서 마크는 찍히지만, **그 결과를 채팅 쪽에 되돌려주는 경로가 없음**

## 결과 ①: 죽은 클릭

큐를 거친 제안의 스텝을 클릭해도 `markId`가 없어 아무 일도 일어나지 않는다. PR이 추가하려는 기능 자체가 동작하지 않는다.

## 결과 ②: 엉뚱한 위치로 점프 (더 심각)

`findPendingProposalPart`는 "markId가 없는 첫 번째 propose_change 파트"를 순서대로 찾는다. 큐에 갇혀 미스탬프된 파트는 **갓 생성된 파트와 구분이 안 된다**.

시나리오:

- `ToolPart_1`: 탭 이동 중 도착 → 큐로 → 미스탬프
- 사용자 A로 복귀
- `ToolPart_2`: 즉시 적용 성공 → `findPendingProposalPart`가 **`ToolPart_1`을 먼저 발견** → `ToolPart_2`의 `markId`가 `ToolPart_1`에 박힘
- 사용자가 스텝 1 클릭 → **제안 2의 마크로 점프** (잘못된 위치)
- 스텝 2 클릭 → `markId` 없음 → 죽은 클릭

## UX 관점에서의 문제

### 시나리오

사용자가 AI에게 "이 글 좀 다듬어줘"라고 부탁. AI가 글 곳곳에 여러 수정 제안을 만들고, 채팅 패널에 "✏️ 첫 문단 수정", "✏️ 결론 보강" 같은 스텝이 쌓인다. 각 스텝을 클릭하면 에디터가 해당 위치로 점프해야 한다.

AI가 제안을 만드는 동안 사용자가 다른 노트 탭으로 잠깐 이동한다. 다시 원래 문서로 돌아오면 마크는 잘 찍혀 있고 채팅에도 스텝이 보여서 겉으론 멀쩡하다.

### 사용자가 겪는 두 가지 황당함

**① 죽은 클릭**
스텝을 클릭해도 아무 일이 안 일어난다. 다른 스텝은 되는데 이것만 안 된다. 버그인지 잘못 누른 건지 사용자가 판단할 근거가 없다.

**② 엉뚱한 곳으로 점프**
"첫 번째 제안" 스텝을 클릭했는데 다른 문단으로 스크롤된다. 사용자는 "AI가 여기를 고치자는 거였나?" 하고 그 문단을 들여다본다. 사실은 다른 제안의 위치인데, 사용자는 모른다.

### 왜 위험한가

AI가 "여기를 고치자"고 가리킨 위치를 사용자는 그대로 믿는다. 채팅 스텝의 텍스트와 실제 점프 위치가 안 맞으면 사용자는 둘 중 어느 게 진짜인지 판단할 근거가 없다.

**"AI가 가리키는 위치를 믿을 수 있어야 한다"는 신뢰의 근간이 깨진다.**

탭 전환이라는 평범한 행동 하나로. 죽은 클릭은 "기능 고장"으로 보이고 끝이지만, 엉뚱한 점프는 사용자가 잘못된 정보를 진짜라고 받아들이게 만들어서 더 나쁘다.

## 심각도

**중간~높음.**

- 트리거 조건이 좁다 — "채팅 중 탭 이동 → 제안 도착 → 복귀 후 다음 제안" 순서가 맞아야 한다.
- 데이터 손실·크래시는 없다.
- 하지만 글로벌 룰("**굉장히 Reliable해서 에러가 전혀 없어야**")에 비춰보면 **머지 전 처리 권장**.
- 동작 안 하는 것보다 잘못 동작하는 게 더 나쁘다.

## 근본 원인 분석

지금 구조는 **markId 발급 위치**와 **ToolPart 스탬프 위치**가 분리되어 있다.

- markId는 `applyProposal`이 에디터에 마크를 찍을 때 발급
- ToolPart 스탬프는 `chat.ts`의 proposal 리스너에서 수행
- 둘은 "즉시 적용" 경로에서만 한 호흡에 이어지고, **큐잉 경로에서는 끊김**

게다가 ToolPart와 proposal 이벤트를 잇는 매개체가 `tool_use_id` 같은 명시적 키가 아니라 **"미스탬프 파트 중 첫 번째"라는 순서 추정**이다. 이게 결과 ②의 직접 원인.

## 정공법

### 1. markId 발급 시점을 "마크 찍기"에서 분리 (이 PR 범위)

`applyProposal` 진입 시점에 markId를 먼저 만들고, 그걸로:

- 에디터 마크 메타에 박고
- 큐에 enqueue 할 때도 같이 넣고
- `ToolPart`에도 즉시 스탬프

이러면 즉시 경로/큐잉 경로가 동일하게 "markId는 항상 발급되고 항상 스탬프된다"로 통일된다.

→ 미스탬프 파트가 존재하지 않게 되므로 **결과 ①·② 모두 해결**.

### 2. ToolPart ↔ proposal 상관관계를 순서가 아니라 명시적 키로 (별도 작업)

현재 사이드카의 `claude:proposal` 이벤트가 `tool_use_id`를 안 실어 보내서 순서로 추정한다. 정공법은 사이드카 쪽 MCP 릴레이 핸들러에서 `tool_use_id`(혹은 클라이언트가 발급한 nonce)를 함께 발행하도록 고치는 것.

이건 사이드카 ↔ 클라이언트 계약 변경이라 PR이 커진다. 별도 작업으로 분리.

## 우선순위

- **1번만 해도** 두 결과 모두 사라진다.
- **2번**은 "순서 추정"이라는 설계 부채를 없애는 더 큰 작업. 추후 병렬 tool_use, 재시도, out-of-order 이벤트 대응에 유리.

이번 PR 범위 안에서는 **1번**으로 정공법.

## 다른 발견 (참고)

플래그하지 않은 minor 항목:

- `scrollToProposal.ts:30` — 활성 탭이지만 마크가 실제로 없는 경우에도 `pendingScroll`에 큐잉. 무해하지만 주석과 어긋남.
- `MilkdownEditor.tsx:359` — rAF로 미룬 `scrollToMark`가 view destroy 이후 실행될 가능성. PM에서 사실상 no-op이라 위험 낮음.
- `chat.ts:376`에서 `'propose_change'` 문자열 직접 사용 vs 다른 곳은 `PROPOSE_CHANGE_TOOL` 상수 — 스타일 정도.
