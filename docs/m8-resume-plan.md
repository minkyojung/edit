# 자고 일어나서 할 것 — M8.3 이어서

작성: 2026-05-01
상태: 진행 중 (Phase 4-A 검증 직전 멈춤)

---

## 지금까지 한 것 (참고)

- ✅ M8.0 Claude OAuth (PKCE + 암호화 파일 저장)
- ✅ M8.1 Anthropic SDK 통합 (Rust 프록시 경유)
- ✅ M8.2 AI Review (copyeditor skill, single-turn, propose_change)
- ✅ M8.3 Phase 1 — ChatPanel 골격
- ✅ M8.3 Phase 3 — ProposalSnippet diff 카드 + 액션
- 🟡 M8.3 Phase 4-A — `jumpToMark` 구현했으나 **검증 전에 다른 버그 발견되어 멈춤**

---

## 발견된 두 가지 구조적 버그

### 버그 1. 데코가 한 칸씩 어긋남 (drift)

타이핑할 때마다 노란 deco가 좌측으로 1칸씩 밀림.

**원인**: 이중 앵커 시스템
- inline `proofSuggestion` mark (PM 자동 추적) — 제대로 따라감
- `Y.Map`의 startRel/endRel char offset (수동 갱신, stale)
- `markDecoPlugin`이 Y.Map 좌표로 deco → 텍스트보다 한 칸 옆에 그림

### 버그 2. UI 전체 사라짐 (cascade failure)

오타 → AI Review → 화면 빈 페이지.

**원인**:
- `ProposalSnippet`이 Radix `Tooltip` 사용 — 그런데 `TooltipProvider` 없음
- Error Boundary 없음 → 한 컴포넌트 에러 = 전체 unmount

### 버그 3. 마크 잔재 (orphan)

마크된 텍스트 삭제됐는데 카드/Y.Map 엔트리 그대로.

**원인**: cleanup 메커니즘 없음
- inline mark는 PM이 자동 정리
- Y.Map은 명시적 `delete()` 안 부르면 영구
- 사용자가 본문 직접 편집 시 Y.Map 정리 코드 어디에도 없음

---

## 작업 순서 (이 순서대로!)

### 🔴 1순위: 즉시 안정화 (필수, ~1.5h)

다음 작업의 토대. 이 안 풀면 계속 사고남.

**1-A. TooltipProvider 추가** (10m)
- `App.tsx` 또는 `ThemeProvider` 안에 `<TooltipProvider>` 추가
- 다른 Radix 컴포넌트(Popover, Dialog)도 같이 점검
- 검증: ProposalSnippet [↗️] 호버 시 tooltip 정상

**1-B. ErrorBoundary 도입** (20m)
- 최소 라우트 레벨 + ChatPanel 래핑
- fallback UI: "문제 발생, 다시 시도해주세요"
- 한 컴포넌트 죽어도 다른 부분 살아있게

**1-C. 단일 앵커로 통일** (1h)
- `markDecoPlugin` 제거 또는 변경
- 옵션 A (추천): 제거. inline mark의 toDOM(`data-proof` attr)에 CSS 스타일 직접 적용해서 시각화
- 옵션 B: markDecoPlugin이 Y.Map 안 보고 inline mark의 PM position을 직접 사용
- 검증: 타이핑해도 deco 안 어긋남

---

### 🟡 2순위: Cleanup 자동화 (~30m)

버그 3 (잔재) 해결. 1순위 완료 후.

**2. PM transaction hook으로 Y.Map 자동 정리**
- 새 plugin: 매 doc 변경 후 inline mark id 모아서 Y.Map과 비교
- inline mark에 없는 Y.Map 엔트리 → 자동 delete
- 검증: 마크된 텍스트 삭제 시 카드도 자동 사라짐 (또는 'rejected' 표시)

```typescript
// 핵심 코드 스케치
new Plugin({
  appendTransaction(trs, oldState, newState) {
    if (!trs.some(tr => tr.docChanged)) return null
    const liveIds = new Set<string>()
    newState.doc.descendants(node => {
      for (const m of node.marks) {
        if (['proofSuggestion', 'proofComment'].includes(m.type.name) && m.attrs.id) {
          liveIds.add(m.attrs.id)
        }
      }
    })
    const marksMap = ydoc.getMap('marks')
    marksMap.forEach((_, id) => {
      if (!liveIds.has(id)) marksMap.delete(id)
    })
    return null
  }
})
```

---

### 🟢 3순위: Phase 4-A 검증 (10m)

위 안정화 끝나면 이전에 못 한 검증.

**3. snippet → 본문 점프 검증**
- AI Review 실행 → 카드 [↗️] 클릭 → 본문 스크롤 + 1초 flash 깜빡 확인
- 잘 되면 Phase 4-A 완료 마킹

---

### 🟢 4순위: Phase 4-B — 본문 → snippet 점프 (~45m)

**4-B. inline mark 클릭 → chat snippet 스크롤**
- MilkdownEditor에 `handleClick` plugin 추가
- 클릭한 위치의 mark에서 markId 추출
- 글로벌 이벤트 dispatch (또는 콜백 체인)
- ChatPanel에서 listen → `data-mark-id` 가진 snippet 찾아 scrollIntoView + flash

---

### 🔵 5순위: 커밋 + 잔재 정리 (~30m)

**5-A. 그동안 작업 커밋푸시**
**5-B. 더는 안 쓰는 코드 정리**:
- `ContextPanel.tsx` (대체됨)
- `proofClient.createMark/acceptMark/rejectMark` (안 씀)
- `markDecoPlugin.ts` (1-C에서 제거했으면)
- 임시 디버그 로그

---

## 결정 안 한 것 (지금 안 정함)

### Phase 5 (자유 채팅)
- M8.3 마지막 큰 단계
- "Run Review" 외에 임의 텍스트 입력 → AI 답변
- 4시간 정도. 1~5순위 끝나고 결정.

### M8.4 (multi-turn tools)
- search, read_document 등 추가
- 긴 문서/반복 검토에서 정확도 ↑
- 우선순위 낮음. 사용 중 약점 발견되면.

---

## 시작할 때 체크리스트

- [ ] 이 문서 다시 읽기 (5분)
- [ ] 1-A 시작 (TooltipProvider)
- [ ] 1-B (ErrorBoundary)
- [ ] 1-C (단일 앵커) — 가장 큰 변경
- [ ] 1순위 끝나면 검증 + 커밋
- [ ] 2 (cleanup hook)
- [ ] 3 (Phase 4-A 검증)
- [ ] 4-B (반대 방향)
- [ ] 5 (정리)

총 예상: **3~4시간**.
