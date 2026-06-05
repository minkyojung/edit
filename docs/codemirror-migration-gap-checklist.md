# CM 이주 — 기능 갭 & 실행 체크리스트

> 기존 PM(Milkdown) 에디터에는 있는데 CM 프로토타입(`src/prototypes/`)에는 아직 없는
> 것을 정리한 실행용 체크리스트. 평가는 끝났고(전 영역 정공법 검증, GO 판정 —
> `codemirror-migration-decision.md` §7~10), 이 문서는 "실제 전면 이주 때 남은 일"의
> 목록이다. 핵심: **리스크가 아니라 분량 + 마감.** 2026-06-05.

## 0. 프로토타입에 이미 검증된 것 (참고)
livePreview(WYSIWYG Tier1+2) · 카드(이미지/영상/오디오/Mermaid) · 편집 키맵 · 슬래시 ·
위키링크(자동완성/클릭/깨진링크) · 서식 단축키 + 링크(만들기/열기) · 하이라이트 ·
미디어 드롭/붙여넣기 · placeholder/저장감지. (전 영역 헤드리스 테스트 + 손확인, 366 green)

## A. 핵심 — 미구현 (실제 이주 시 꼭) 🔴
- [ ] **AI 인라인 리뷰 UI** — 제안 표시 + 수락/거절 칩을 실제 에디터에 연결.
  앵커 *로직*은 `__poc__` 헤드리스로 증명됨(안정성 100%), **화면 배선이 남음.** 최대 공백.
  (PM: inlineReviewPlugin/markReconcile/markStamp/pendingTargets)
- [ ] **시각화 3종 + 합성엔진** — Mermaid만 했음. Artifact / Chart(VizBlock) /
  GitHub-activity 위젯 + vizBlockOps. (viz React 컴포넌트는 재사용 가능)
- [ ] **댓글(proofComment)** — 제안과 별개 마크.

## B. 작은 기능 — 정공법 알지만 미구현 🟡
- [ ] **링크 호버 바** — 호버 시 열기/편집/제거 (현재 Cmd+클릭 열기만). PM:
  linkHoverPlugin/LinkHoverBar/LinkEditInput
- [ ] **위키링크 라벨 동기화** — 노트 rename → `[[Old]]`→`[[New]]` 일괄(볼트레벨 텍스트 치환)
- [ ] **붙여넣기 새니타이저** — 위험 href 제거 + `note:` 스킴 보존
- [ ] **이미지 alt 편집 UI** — (CM은 원문 reveal로 대체 가능, 전용 UI는 선택)
- [ ] **번호 리스트 재넘버링** — 들여쓸 때 형제 번호 자동 정리
- [ ] **리비전 브로드캐스트 배선** — 현재 dirty/rev는 표시만, 실제 신호 연결(docVersionPlugin)
- [ ] 카드 드롭 커서 보정 (cardDropAdvanceCursor 대응 — 필요 시)

## C. 의도적으로 뺀 것 / 도메인·범위 밖 ⚪ (이주 안 함, 기록용)
- 선택 툴바 (단축키+슬래시로 대체) — 발견성 문제 시 additive 재도입 가능
- 커스텀 캐럿 (CM 기본 사용)
- 데일리 가드 — 제품 도메인 규칙(에디터 무관, 별도 이식)
- git 거터 (aiEditGutterPlugin) — 별개 기능
- 프론트매터(YAML) — 미정

## D. 에디터 밖 UI — 거의 그대로 재사용 (연결만) 🟢
- [ ] EditorTabs(문서 제목 탭) · UnlinkedNotes(하위 노트 푸터) 연결
- [ ] HighlightNoteField(메모 편집 UI)를 하이라이트 클릭에 연결 (현재 토스트)
- [ ] 슬래시 실제 액션: 이미지 파일 다이얼로그→볼트 복사, GitHub 앵커 (현재 텍스트 stub)

## E. (가장 중요한 메타) 스텁 → 실제 시스템 배선 🔴
프로토타입은 전 기능이 **가짜 데이터**로 동작 — 진짜 연결이 전 영역에 걸쳐 남음:
- [ ] 에디터 셸: MilkdownEditor → CM EditorView를 docsStore.bodyMarkdown 로드/저장에 연결
      (parser/serializer 제거, doc=마크다운)
- [ ] 노트 목록: 정적 stub → docsStore.knownDocs (슬래시·위키링크 후보)
- [ ] 미디어: object URL → 실제 볼트 임포터(importImageFile 등)
- [ ] 이동/열기: 토스트 → 실제 라우터 이동 / Tauri 시스템 브라우저
- [ ] 하이라이트: 정적 레코드 → article `.meta.json` 레코드
- [ ] 저장: 디바운스 흉내 → flushDirty(실제 디스크)

## F. 마감(cosmetic) 🟢
- [ ] 슬래시 팝업 색 토큰 + @tabler 아이콘
- [ ] mermaid 엣지 색 / 드롭커서 색은 적용됨 — 그 외 다크 테마 색 점검
- [ ] 코드블록 문법 하이라이팅(현재 모노 블록만)

## G. 안전장치 (전면 이주 실행 시 필수) 🔴
- [ ] **유효성 드리프트 가드** — 모델이 깨진 mermaid/HTML 생성 시 폴백·검증(카드 폴백은 있음)
- [ ] undo/IME/접근성/모바일 회귀 테스트 셋업 (PM이 다진 영역)

---

## 우선순위 한 줄 정리
- **먼저(큰 가치)**: E(에디터 셸 배선) → A(AI 리뷰 UI) — 제품의 본류
- **그 다음**: A(시각화 3종) → B/D(나머지 기능·UI 연결)
- **마지막**: F(마감) · G(안전장치는 배선과 병행)
- **안 함**: C
