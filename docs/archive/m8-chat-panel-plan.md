# M8.3 — Chat Panel + 인라인 데코 (Cursor-style)

작성: 2026-05-01
상태: **Draft** — 구현하면서 다듬을 것

---

## 결정한 방향

우측 패널을 **ContextPanel(마크 리스트)** → **ChatPanel** 로 교체.
Cursor 패턴 차용:

- 채팅이 AI와의 통합 surface (Review 트리거 + 결과 표시 + 자유 대화 여지)
- AI 제안은 **chat 메시지의 snippet 카드**로 표시 (diff 형식)
- 동시에 **에디터 본문에 인라인 데코**(노란 배경 등) — 이미 동작
- snippet ↔ 인라인 mark **양방향 네비게이션**

---

## Cursor가 하는 방식 (참고)

3개 surface 중 우리 시나리오에 가까운 건 **Cmd+L 사이드바 채팅**:

```
[Editor]                 [Chat: Cmd+L]
                           User: review this
                           AI: 4 issues found
                           
                           ┌────────────────┐
                           │ - i went       │  ← red
                           │ + I went       │  ← green
                           │ [Apply]        │
                           └────────────────┘
                           ┌────────────────┐
                           │ [next snippet] │
                           └────────────────┘
                           
                           [Apply All]
```

핵심 디테일:
- snippet = diff 형식 (red `-` / green `+`)
- 각 snippet에 `Apply` 단위 적용 + 전체 `Apply All`
- 본문에서 영향받는 위치 인라인 강조
- snippet 클릭 → 본문 스크롤
- Cmd+Enter 모두 수락 / Cmd+Backspace 모두 거절
- v2.3+: 인라인 데코 on/off 토글 (사용자 취향)

---

## writer-tauri로 매핑

```
[Sidebar]   [Editor]                    [Chat Panel]
            ┌───────────────────┐       ┌──────────────────┐
            │  i went to store ◢◣│  ←연결→ │ User: review     │
            │  yesturday        │       │ AI: 4 suggestions │
            │                    │       │                   │
            │ (인라인 데코)      │       │ ┌────────────────┐│
            └───────────────────┘       │ │"i went"        ││
                                        │ │  → "I went"    ││
                                        │ │ [수락][거절]   ││
                                        │ │ [↗️ 본문에서]   ││
                                        │ └────────────────┘│
                                        │ ...               │
                                        │ [Run Review][⌨️]   │
                                        └──────────────────┘
```

### Cursor와 우리 차이

| | Cursor | writer-tauri |
|---|---|---|
| 데이터 | 파일 텍스트 | Y.XmlFragment + Y.Map(marks) |
| 변경 단위 | 라인 diff | 단어/구문 (quote → content) |
| 적용 | 파일 직접 수정 | proofSuggestion 마크 수락 시 PM transaction |
| Undo | git history | Yjs CRDT |

기본 UX(snippet + 인라인 + 양방향) 그대로, 데이터 모델만 우리 것.

---

## 컴포넌트 (대략 — 구현하며 다듬음)

### ChatPanel
- 메시지 리스트
- 입력 composer (텍스트 입력 + "Run Review" 버튼)
- 영속화: 일단 메모리, 나중에 Y.Array

### Message
- role: `user` | `assistant`
- text 본문
- assistant 메시지에 `proposals: Proposal[]` 첨부 가능

### ProposalSnippet
- diff 시각화 (red `-` / green `+`)
- `kind` (replace/insert/delete/comment) 표시
- rationale
- [수락] / [거절] 버튼 → 기존 `markActions` 호출
- [↗️ 본문에서] 클릭 → 에디터 mark 위치로 스크롤

### 인라인 데코 (기존 `markDecoPlugin`)
- 그대로 유지
- 클릭 시 chat에서 해당 snippet으로 스크롤 (M8.3 단계에서 추가)

---

## 작업 순서 — Phase

### Phase 1. ChatPanel 골격 (1~2h)
- `ContextPanel.tsx` → `ChatPanel.tsx` 교체 (또는 토글)
- 메시지 리스트 + composer
- "Run Review" 버튼이 기존 `runReview` 호출
- 마크 시스템은 변경 없음 (백엔드 그대로 동작)

### Phase 2. AI Review → Chat 메시지화 (1h)
- runReview 시작 시 user message 추가
- 응답 시 assistant message + proposals 첨부
- 마크 자동 생성 (지금처럼)
- "검토 중…" 상태 표시 (스피너)

### Phase 3. ProposalSnippet 카드 (1.5h)
- chat 메시지 안에 list로 proposal 표시
- diff 형식 렌더링
- [수락]/[거절] → `markActions.acceptMark` / `rejectMark`
- 수락/거절된 snippet은 색상 어둡게 (해결됨 표시)

### Phase 4. 양방향 네비게이션 (1h)
- snippet 클릭 → 에디터 mark로 스크롤
- 에디터 inline mark 클릭 → chat snippet으로 스크롤

### Phase 5. 자유 대화 (선택, 2h+)
- 입력창에 임의 텍스트 → AI 응답 (마크 없는 일반 답변)
- 대화 히스토리 영속화

### Phase 6. 다듬기
- 에러 처리 (인증 만료, 네트워크 실패)
- 키보드 단축 (Cmd+Enter 수락 등)
- 인라인 토글 옵션 (Cursor v2.3+ 패턴)

---

## 결정된 것

- 우측 = ChatPanel (탭 분리 안 함)
- 마크 시스템 백엔드 그대로 유지 (proofSuggestion + Y.Map)
- 첫 단계는 Review 위주, 자유 대화는 후순위

## 미결 / 구현하며 결정

- 메시지 영속화 시점 (메모리 / Y.Array)
- 다중 review run의 chat history 누적 방식
- 인라인 데코 on/off 옵션 위치
- ProposalSnippet 디자인 디테일
- "검토 중" UI 형태 (스피너만 / focus area 진행률 / 스트리밍)

---

## 의존성

- 기존 `markActions.ts` (수락/거절)
- 기존 `runReview.ts` (실행)
- 기존 `markDecoPlugin.ts` (인라인 데코)
- 새로운 `ChatPanel.tsx`, `Message.tsx`, `ProposalSnippet.tsx`
- 메시지 store (Zustand 또는 useState)
