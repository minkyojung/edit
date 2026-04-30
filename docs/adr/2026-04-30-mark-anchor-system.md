# ADR: 마크 앵커 시스템 — proof-sdk inline mark 통합

작성: 2026-04-30
상태: **Accepted**

---

## Context

`writer-tauri`는 proof-server(proof-sdk 풀스택)와 Hocuspocus(WebSocket Yjs) 위에 올라가는 Tauri 클라이언트. 마크(코멘트, 제안 등) 생성 / 수락 / 거절 흐름을 구현하면서 다음 패턴들을 차례로 시도하고 깨졌다.

### 시도 1 — REST ops API + PM 좌표 전송 (실패)

```
클라: createMark({ range: { from, to } })  → HTTP POST /api/documents/:slug/ops
서버: range 받아서 startRel/endRel 계산 → 저장
```

**깨진 이유**: 클라가 보낸 PM position과 서버가 추정한 markdown char offset이 일치하지 않음. 수락 시 좌표 검증 실패 → **HTTP 409 Conflict**.

### 시도 2 — REST ops API + char offset 전송 (실패)

```
클라: createMark({ startRel, endRel })  ← buildTextIndex로 직접 계산
서버: 받은 그대로 저장
```

**깨진 이유**: 좌표 정합성은 맞아짐. 하지만 수락 시 `collectAnchorRanges()`가 본문에서 inline mark anchor를 찾는데, 우리는 inline mark를 박지 않았음 → 빈 결과 → 텍스트 mutation **silent skip**. 메타데이터(authored 마크 생성, replace 마크 제거)만 적용되고 본문은 그대로.

### 시도 3 — inline mark 추가 + REST ops API (실패)

```
클라: 1) tr.addMark(proofSuggestion, {id: X}) ← 본문 stamp
      2) createMark({ markId: X })            ← 서버 호출
```

**깨진 이유**: 서버의 `suggestion.add` 핸들러는 `const id = randomUUID()`로 **클라가 보낸 markId를 무시하고** 자기 새 UUID를 생성. 결과:
- Y.Map mark.id = 서버 UUID
- 본문 inline mark.id = 클라 UUID
- 서버 수락 시 `nodeMark.attrs.id === mark.id` 매칭 실패 → 다시 silent skip.

### 시도 4 — Y.Map 직접 쓰기 + inline mark (부분 성공)

```
클라: 1) tr.addMark(proofSuggestion, {id: X})
      2) ydoc.getMap('marks').set(X, {...})  ← REST 우회, 직접 쓰기
```

**진척**: Y.Map mark.id == inline mark.id (둘 다 X). 좌표/매칭 정상.

**여전히 깨짐**: 수락은 여전히 REST API(`suggestion.accept`) 사용. 서버가 텍스트 교체를 시도하지만 다음 경로에서 본문 mutation이 사라짐:

```
서버 acceptMark() → ProseMirror state에서 텍스트 교체
                  ↓ finalizeRehydratedState()
                  → markdown 문자열로 직렬화
                  → mutateCanonicalDocument()가 markdown을 다시 파싱
                  → Y.XmlFragment에 쓰기
                  ↳ markdown roundtrip에서 inline mark structure 손실
                  ↳ 결과적으로 Y.XmlFragment는 옛 상태 그대로
```

→ 메타데이터(Y.Map)는 갱신되는데 본문(Y.XmlFragment)은 그대로 → **"phantom replace"**.

## Decision

**최종 패턴**: 마크의 모든 mutating 동작을 클라이언트 ProseMirror transaction + Yjs 직접 쓰기로 처리. REST ops API는 사용하지 않음.

```
마크 생성:
  1. crypto.randomUUID() 로 markId 생성
  2. view.dispatch(tr.addMark(proofSuggestion, {id, kind, content, ...}))
  3. ydoc.getMap('marks').set(markId, {kind, quote, content, startRel, endRel, ...})

마크 수락:
  1. doc.descendants 로 inline mark anchor 찾기 (markId 매칭)
  2. view.dispatch(tr.replaceWith(from, to, schema.text(content)))
  3. ydoc.getMap('marks').delete(markId)

마크 거절:
  1. inline mark anchor 찾기
  2. view.dispatch(tr.removeMark(from, to, proofSuggestion))
  3. ydoc.getMap('marks').delete(markId)
```

이 패턴은 proof-sdk 웹 클라이언트와 동일. y-prosemirror가 PM transaction을 Y.XmlFragment로 자동 sync, Hocuspocus가 서버에 binary update 전송. 서버는 받기만 함, mutation 안 함.

## Consequences

### Positive
- 좌표계 충돌 / ID 미스매치 / markdown roundtrip 손실 모두 회피
- Yjs CRDT 가 모든 sync를 책임 → 클라/서버 간 일관성 보장
- 코드 단순함: HTTP 핸드셰이크 / 응답 처리 / 에러 코드 매핑 모두 불필요

### Negative
- 서버 측 검증 / 권한 체크 / side effect 우회됨 (단일 사용자 데스크톱 앱이라 OK)
- 서버 ops API 일부(`suggestion.add`, `suggestion.accept`, `suggestion.reject`)가 우리 코드에서 dead path로 존재 → proofClient에서 제거 필요

### Notes for future
- **proof-sdk와 같은 좌표/스키마 모델**을 그대로 사용해야 서버가 Y.XmlFragment 받을 때 inline mark를 인식. `proofMarkSchemas.ts`가 이 호환층.
- **`buildTextIndex`/`mapTextOffsetsToRange`** 등 anchor 계산 유틸은 proof-sdk에서 직접 복사 (`utils/textRange.ts`).
- **REST API는 agent / headless 시나리오 용**. 클라가 있을 땐 클라가 처리.

## Files

핵심:
- `src/editor/proofMarkSchemas.ts` — 5개 inline mark 스키마 (proofSuggestion, proofComment, proofFlagged, proofApproved, proofAuthored)
- `src/editor/markActions.ts` — `acceptMark`, `rejectMark`, `resolveComment` 클라 액션
- `src/editor/MarkToolbar.tsx` — 마크 생성 시 inline stamp + Y.Map 직접 write
- `src/editor/utils/textRange.ts` — anchor 좌표 변환 유틸 (proof-sdk 카피)

지원:
- `src/editor/selectionPlugin.ts` — selection에 EditorView 같이 노출
- `src/editor/MilkdownEditor.tsx` — `onViewReady` 콜백으로 view 외부 노출
- `src/layout/ContextPanel.tsx` — accept/reject 클릭 → markActions 호출
