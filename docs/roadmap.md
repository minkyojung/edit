# Wiki-LLM Writer — 앞으로 할 것 (2026-04-29)

지금 브랜치 (`minkyojung/wiki-llm-writer`) 는 **핵심 메커니즘**까지 완료. 다음부터는 UI 레이어 + 부가 기능. PR 단위로 분리해서 진행.

---

## PR 1 — UI 통합 + shadcn 도입

**브랜치 (예시)**: `minkyojung/ui-shadcn`

### 1-A. shadcn 설치 + 디자인 토큰
- [ ] shadcn/ui CLI 설치
- [ ] Tailwind 설정 (Electron + Vite 환경)
- [ ] `components.json` 셋업
- [ ] 디자인 토큰 (color, spacing, font) 정의
- [ ] 다크 모드 토큰 준비 (옵션)

### 1-B. Bulk Actions
**로직** (`markPlugin.ts`):
- [ ] `acceptAllMarks(view)` — 화면 보이는 모든 pending 마크 일괄 수락
- [ ] `rejectAllMarks(view)` — 일괄 거절
- [ ] tombstone 일괄 추가 + API 호출

**UI**: 헤더 우상단에 카운터 칩
```
3개 제안 [✓] [✕]
```
- [ ] 마크 갯수 표시
- [ ] 모두 수락 / 모두 거절 버튼
- [ ] 단축키 `⇧⌘A` / `⇧⌘R`
- [ ] 0개면 자동 숨김

### 1-C. 기존 컴포넌트 shadcn 마이그레이션
- [ ] `WikiModal` → shadcn `Dialog`
- [ ] `SignInPanel` → shadcn `Card` + `Button` + `Input`
- [ ] `AccountIndicator` → shadcn `DropdownMenu`
- [ ] 에이전트 에러 토스트 → shadcn `Toast` (또는 `Sonner`)

### 1-D. 정리
- [ ] 안 쓰는 인라인 스타일/CSS 제거
- [ ] 일관된 톤 점검 (라운드, 그림자, 간격)

---

## PR 2 — Comment 마크 (proof-sdk 다른 큰 축)

**브랜치 (예시)**: `minkyojung/comments`

### 2-A. Schema + 플러그인
- [ ] `proofComment` mark schema 추가 (`commentMark.ts`)
- [ ] Y.Map('marks') 의 comment 종류 인식해서 decoration 렌더
- [ ] kind: 'comment' 마크는 별도 색 (옅은 노란색)

### 2-B. UI
- [ ] 마크에 마우스 오버 시 코멘트 텍스트 popover
- [ ] 코멘트 추가 흐름 — 텍스트 선택 → 단축키 또는 우클릭
- [ ] 코멘트 답글/해결 (resolve)

### 2-C. AI 코멘트
- [ ] 시스템 프롬프트에 `add_comment` 도구 추가 (옵션)
- [ ] 에이전트가 단순 수정 외 의견을 코멘트로 남기도록

---

## PR 3 — 마우스 호버 액션 바

**브랜치 (예시)**: `minkyojung/hover-actions`

키보드 외 사용자용:
- [ ] 마크 위 호버 시 부유 [✓][✕] 버튼
- [ ] `view.coordsAtPos` 으로 위치 계산
- [ ] React Portal 로 띄우기
- [ ] 클릭 → 해당 마크만 처리 (단일)

---

## PR 4 — 작성자 통계 패널

**브랜치 (예시)**: `minkyojung/authorship-stats`

- [ ] 사이드 토글 패널 — 글에서 사람/AI 비중
- [ ] proofAuthored 마크 순회해서 글자 수 집계
- [ ] "이 글의 23%는 AI 작성" 같은 표시
- [ ] AI 부분만 강조 표시 토글

---

## PR 5 — 멀티 문서 지원

**브랜치 (예시)**: `minkyojung/multi-docs`

지금 한 사용자 = 한 문서. 여러 글 작성 가능하게.

- [ ] 사이드바 — 문서 목록
- [ ] "새 글" 버튼
- [ ] 각 문서마다 belief 위키 → 공유 vs 별도? 결정 필요
- [ ] 문서 메타데이터 (제목, 생성일, 마지막 수정)
- [ ] 검색 (선택)

---

## PR 6 — Wiki 에디터 정식화

지금 textarea. 정식 Tiptap/Milkdown 에디터로 교체.

- [ ] 위키 에디터 모달 → 별도 탭/창
- [ ] 마크다운 단축키 지원
- [ ] 실시간 자동 저장
- [ ] 에이전트 세션 자동 갱신 (이미 있음)

---

## 보류 / 장기

### 멀티 에이전트 (P4 원본 계획)
- Fact-checker, Voice-mimic 등 추가 에이전트
- Orchestrator 레이어
- 단일 에이전트 + provenance 가 충분한지 베타 사용자 피드백 후 결정

### 하네스 추상화 (Codex/Gemini)
- claude-agent-sdk 외 다른 SDK 어댑터
- proof-sdk op 으로 통일
- claude-agent-sdk 가 안정적인 동안은 우선순위 낮음

### Memory-writer 정식
- 지금: 교열 대화 → belief 자동 업데이트 (단순)
- 장기: Extractor / Reconciler 분리, Gmail/캘린더 신호

### Quota 모니터링
- usage 기록
- 일일 사용량 표시
- 90% 도달 경고

---

## 우선순위 추천

1. PR 1 (UI + shadcn + Bulk) ← 다음
2. PR 2 (Comment) ← 그 다음, proof-sdk 가치 깊이 더함
3. PR 3 (호버 액션) ← UX 보완
4. PR 4 (통계) ← 차별화 포인트
5. PR 5 (멀티 문서) ← 베타 사용자 피드백 후 결정
6. PR 6 (Wiki 에디터 정식화) ← 그 후
