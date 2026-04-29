# Note 제품 설계 — 인터뷰 기록

> proof-sdk 위에 로컬-first 노트 제품을 만들기 위한 설계 결정 사항을 한 덩어리씩 인터뷰하며 채워나가는 문서.

## 진행 상태

- [x] Q1. 제품 좌표 (어떤 노트앱에 가까운가)
- [x] Q2. 위키 ↔ 노트 관계
- [x] Q3. v1 organization (Daily 트리 + 태그)
- [x] Q4. 동기화 전략 (v1 단일 디바이스 + 마크다운 git 백업)
- [x] Q5. 레이아웃 zone 구성 (2-pane + 우측 토글)
- [x] Q6. 노트 라이프사이클
- [x] Q7. 에이전트 — 노트별 세션 정책
- [x] Q8. 위키 가시성 (구조 v1, UI 형태는 미정)
- [x] Q9. 채팅 UX (글로벌 + Context Engineering)
- [x] Q10. 디렉터리/코드 재구성 범위 (PR B 에서 한 번에)
- [x] Q11. 상태관리 (Zustand 도입, 글로벌만)
- [x] Q12. 구현 PR 순서 확정

---

## Q1. 제품 좌표 ✅

**결정: 메인은 A (Bear-like 장문 글쓰기), 위키 영역만 C (Obsidian-lite atomic) 성격.**

### 근거 (proof-sdk 관점)

- proof-sdk 의 핵심 가치 = **글자 단위 provenance + 인라인 suggestion 마크**. 이 둘은 한 페이지에 마크가 dense 하게 누적될 때 가치가 폭발 → 장문 글쓰기 모델(A)이 최적.
- proof-sdk agent-bridge 는 "1 문서 = 1 에이전트 세션" 매핑. plan.md §13 의 persistent session + prompt caching 정책은 **장문 전제**에서만 비용/속도가 맞음. atomic note 다발(C)은 세션이 잘게 쪼개져 cache 이점 손실.
- B (Notion 블록/DB) 는 proof-sdk markdown 문서 모델과 mismatch — 채택하지 않음.

### 두 영역의 분리

| 영역 | 좌표 | 누가 정리 | UI 부담 |
|---|---|---|---|
| 사용자가 쓰는 노트 | A — Bear 장문 | 사용자 | 메인 캔버스 |
| 위키 (belief/entity/episode) | C — atomic 그래프 | Memory-writer 자동 | 사이드바 섹션 + 가벼운 뷰 |

→ "글 쓰는 곳은 Bear, 에이전트가 너를 기억하는 곳은 Obsidian-lite" — 한 사이드바 안에 두 섹션으로.

---

## Q2. 위키 ↔ 노트 관계 ✅

**결정: 한 catalog 통합 저장 + 카파시식 write-ownership 분리.**

### 핵심 모델

저장은 통합, 시각은 분리, 권한은 type 별로 코드에 박힘.

| 레이어 | 통합/분리 | 비고 |
|---|---|---|
| 저장 (catalog.json) | **통합** | 모든 노트가 한 파일, `type` 필드로 구분 |
| 사이드바 시각 | **분리** | `Notes` / `Wiki` 두 섹션 |
| Write 권한 | **분리 (type별)** | `writing` = 사용자만 / `wiki:*` = Memory-writer 주, 사용자 review |

### 카파시 LLM Wiki 패턴과의 매핑

카파시 원안 (3-layer: sources / wiki / schema) 의 핵심은 **"파일 위치 분리"가 아니라 "write 권한 분리"** — 같은 git repo 안에 두 폴더로 함께 있음. 우리 매핑:

| 카파시 | 우리 앱 | Write 권한 |
|---|---|---|
| Sources (사용자 원본) | writing 노트 | 사용자 |
| Wiki (LLM synthesize) | belief/entity/episode | Memory-writer (사용자 review 가능) |
| CLAUDE.md (schema) | system prompt + Memory-writer 정책 | — |

→ plan.md §4 (Memory Writer 파이프라인) 가 사실상 카파시 패턴의 proof-sdk 위 구현체.

### 백링크 (자동 생성됨)

proof-sdk provenance `by: "ai:memory-writer from doc:{noteId} rev:{n}"` 가 글자 단위로 출처를 새김 → 백링크가 **데이터에 내재**, reverse index만 만들면 됨. Obsidian의 `[[wikilink]]` 와 달리 사용자 명시 입력 불필요 + 글자 단위 정밀.

### 백링크 UI 시점

- **v1** (PR 1~6, 노트 제품 골격): 백링크 UI 없음. 데이터에는 박힐 뿐 (위키가 아직 비어 보여줄 게 적음).
- **v1.5** (v1 끝나고 P3 시작 전): **forward-only** — 위키 항목 옆 "출처: [글 A, 글 B]" 표시. 가벼운 추가.
- **P3** (Memory-writer 정식 구현, plan.md §9 P3): 양방향 백링크 + reverse index 풀 구현. 위키가 자동으로 자라기 시작.

→ **결정: 백링크 UI 는 v1.5 부터 (forward-only)**.

### 통합의 위험과 보호

통합의 유일한 리스크는 "사용자가 실수로 belief 망가뜨림" — 카파시식 write-ownership 으로 코드 레벨 보호:

- `noteService.write(noteId, source: 'user'|'memory-writer')` — 권한 출처 명시
- `wiki:*` type 노트는 archive/delete 불가 (제품 invariant)
- 사용자 직접 편집은 가능하되 1차 흐름 아님 (review 용도)

---

## Q3. v1 organization ✅

**결정: Daily note 트리 (무제한 깊이) + 태그 후가공. Promote 액션 없음.**

### 핵심 모델

날짜를 1차 organization 축으로, 태그를 후가공 가로축으로 사용. 폴더 없음.

```
저장 / 카탈로그
├─ Daily note: 자동 생성 (앱 켜면 오늘 활성화, 없으면 생성)
├─ Tree 무제한: parentId 로 부모-자식 종속, 깊이 제한 없음
├─ Promote 없음: 자식은 트리 안에 머무름
└─ Tag: 트리를 가로지르는 후가공 수단 (catalog.notes[i].tags: string[])
```

### 사이드바 구조

```
├─ Today (4/29)             ← 항상 최상단, 기본 expand
│   ├─ 회의 메모
│   ├─ 아이디어
│   │   └─ (자식의 자식 가능, 무제한)
│   └─ ...
├─ Recent days (최근 7일)
├─ Older (월별 fold)
├─ 📚 Wiki 섹션 (Q2)
│   ├─ belief
│   ├─ entity / ...
└─ 🏷 Tags (사용 빈도순)
```

### 데이터 모델 영향

```ts
type Note = {
  id: string
  parentId: string | null    // ← 추가. null = 루트 (daily) 또는 정식 위키
  type: NoteType             // 'daily' | 'writing' | 'wiki:*' 등
  tags: string[]
  // ...
}
```

`type: 'daily'` 노트는 항상 `parentId: null` + 제목 = 날짜.

### 엣지 케이스 / 운영 규칙

| 케이스 | 처리 |
|---|---|
| 부모 archive | 자식 모두 cascade archive (복구 시 함께 부활) |
| 부모 hard delete | Leaf 부터 단계적 / 명시적 confirm dialog |
| Daily 노트 archive/delete | 금지 (그날의 anchor — 자식 있어도 없어도) |
| 자식이 여러 daily 에 걸치는 장기 노트 | 부모 1개 제약 — 사용자가 의도적으로 daily 종속 안 시키려면 자식 만들지 말고 별도 노트 (parentId: null) 직접 생성. 이 케이스는 v1 에서 흔치 않음 가정 |
| 깊은 트리 길찾기 | 에디터 상단 breadcrumb 자동 (`Today / 회의 메모 / 결정사항`) |
| Memory-writer 컨텍스트 범위 | 기본 = 자기 노트 + 직계 부모. 옵션으로 ancestor/descendant 확장 |
| 사이드바 노드 폭증 (1년 후) | Today/최근 7일만 기본 expand, 나머지는 월별 fold |

### Promote 를 안 만든 이유

사용자 의도("날짜 중심 + 태그 후가공") 와 일치. 트리는 **시간축**, 태그는 **의미축** 으로 분업 — promote 같은 명시 액션 없이도 충분.

### 트리 무제한 채택의 비용 (인지)

깊이 5+ 시 사이드바 indent 부담, cascade 깊이 무제한 등은 위 운영 규칙 (breadcrumb, 단계적 삭제, fold) 으로 완화. 거부할 사유는 아님.

---

## Q4. 동기화 전략 ✅

**결정: v1 = 단일 디바이스 로컬 + 마크다운 git 자동 백업. 멀티 디바이스는 미래로 deferred.**

### proof-sdk 가 sync 측면에서 가진 자산

| 자산 | 의미 |
|---|---|
| Yjs CRDT | 멀티 클라이언트 충돌 자동 해결 — 분산 동기화 엔진 내장 |
| Hocuspocus WebSocket | CRDT 변경 실시간 전파 |
| 마크다운이 canonical | SQLite 는 저장 디테일. `GET /documents/:slug/state` 로 마크다운 복구 자유 |

→ proof-sdk 는 이미 분산 동기화 시스템. v1 에서는 한 Mac 에서만 돌릴 뿐.

### Sync vs Backup 분리

| | 무엇 | proof-sdk 활용 |
|---|---|---|
| Backup | 디스크 사고 시 마크다운 살리기 | 마크다운 export 가 공짜 → 주기적으로 git 에 덤프 |
| Sync | 두 Mac 에서 같은 노트 | "서버를 어디서 돌리느냐" — CRDT 는 이미 작동 |

### v1 동작

```
[Mac 한 대]
 Electron 앱
   ↓ subprocess
 proof-sdk server (localhost:4000)
   ↓
 SQLite (proof-sdk 내부 — 백업 대상 아님)

백업 (background):
 모든 노트 → 마크다운 export → ~/.../userData/notes/{slug}.md
   → 자동 git commit (디바운스, 5분 idle 후)
```

- SQLite 자체는 백업 안 함 (마크다운에서 복구 가능)
- 마크다운 트리는 카파시 wiki repo 모양과 일관 (Q2 매핑)
- 사용자는 git 의 존재 몰라도 됨. 사고 시 복구 가능

### 미래 (멀티 디바이스 원할 때)

```
[Mac 1]              [Mac 2]
   ↓ WebSocket          ↓ WebSocket
   └── proof-sdk server (어딘가) ──┘
            ↓
         SQLite (한 곳)
```

- 클라이언트 코드 변경 거의 없음 — `PROOF_URL` config 만 변경
- 서버 위치는 그때 결정 (자체 호스팅 / Render / Fly.io / 사용자 NAS)
- **아키텍처는 v1 에서 이미 준비됨**

### Git 백업 도입 시점

**잠정 결정: v1 부터 포함 (α).** 코드 작고, 한 번 박으면 신경 안 써도 됨. CLAUDE.md "에러 없어야" 원칙과 일관.

### 채택하지 않은 옵션

| 옵션 | 이유 |
|---|---|
| iCloud/Dropbox 폴더 동기화 | SQLite WAL 손상 위험 — Reliable 위배 |
| 자체 클라우드 서버 (v1) | v1 범위 밖. 단 proof-sdk 덕에 미래 전환 비용 거의 0 |

---

## Q5. 레이아웃 ✅

**결정: 2-pane + 우측 컨텍스트 패널 토글. 우측 v1 컨텐츠는 채팅 패널로 시작.**

### 구조

```
┌──────────┬─────────────────────────┬──────────────┐
│ Sidebar  │  Editor                 │ Context      │
│ (240px)  │  (max-w 720, centered)  │ (320px,      │
│          │                         │  토글)       │
│ Today    │  [breadcrumb]           │              │
│  ├ 회의  │  [title]                │  💬 Chat     │
│  └ ...   │  [Milkdown 본문]        │              │
│ Recent   │                         │              │
│ Wiki     │                         │              │
│ Tags     │                         │              │
└──────────┴─────────────────────────┴──────────────┘
```

기본 상태:
- 첫 부팅: 좌 열림 + 우 닫힘 (= 2-pane)
- 마지막 토글 상태 기억

### 우측 패널 컨텐츠

**v1: 채팅 패널만.** 사용자 의견 반영 — 메타데이터 위젯 (마크 카운터, 통계, 백링크) 은 시야 노이즈만 만들고 실사용 가치 불분명. 채팅이 가장 명확한 가치.

**채팅 패널 의미 (잠정):**
- 현재 idle-trigger Copyeditor 와 별개로, 사용자가 명시적으로 에이전트와 대화하는 자리
- "이 단락 어떻게 생각해?" / "여기 이어서 써줘" 같은 상호작용
- 본문 마크와 결합 (에이전트가 챗에서 제안 → 본문에 마크 추가)
- **상세 설계는 별도 인터뷰 필요** (어디서 트리거, 컨텍스트 범위, 도구 권한 등)

**v1.5+ 후보** (필요 시 채팅 위/아래 또는 별도 탭):
- 마크 일괄 액션
- Comments 목록 (PR 2)
- 작성자 통계 (PR 4)
- 백링크

### 단축키

| 단축키 | 동작 |
|---|---|
| ⌘1 | 사이드바 토글 |
| ⌘. | 컨텍스트(채팅) 패널 토글 |
| ⌘\ | Focus mode (좌+우 모두 닫음) |

### 폭 / 정렬

| 영역 | 폭 | 비고 |
|---|---|---|
| 좌 사이드바 | 240–280px (resizable) | shadcn 표준 |
| 에디터 본문 | max-w 720px, 가로 가운데 정렬 | 글쓰기 readability |
| 우 컨텍스트 | 320px (resizable) | 토글 펼침 애니메이션 |

### 13" Mac 고려

세 zone 모두 펼쳐도 본문 720px 가운데 정렬 보존. 좁아지면 본문이 밀리지 않고 좌/우 폭이 우선 양보 (resizable 한계 안에서).

---

## Q6. 노트 라이프사이클 ✅

**결정: Archive + Hard delete 두 단계. Cascade. 자유 이동.**

### 6-1. 생성

| 항목 | 결정 |
|---|---|
| Daily 자동 생성 | **α — 앱 켤 때**: 오늘 daily 없으면 즉시 생성, 있으면 활성화. 첫 화면이 항상 today |
| Daily 제목 | **날짜 자동** (`2026-04-29`) — 사용자 편집 가능 |
| 자식 노트 트리거 (v1) | **슬래시 `/`** 명령 + 사이드바 hover `+` 버튼 |
| 자식 노트 트리거 (v1.5) | `[[` 백링크 신택스 추가 (검색/생성 popup) |
| 정식 노트 (parentId: null) | 사이드바 `Notes` 영역의 `+ New` |
| 자식 제목 | 빈 제목 시작, 첫 줄 자동 제목 (Bear 식) |

### 6-2. Archive (soft delete)

**왜 필요한가**: 사용자 글 영구 손실 방지장치. macOS 휴지통과 같은 안전망. CLAUDE.md "에러 없어야" 원칙의 핵심.

| 항목 | 결정 |
|---|---|
| 발동 | ⌘⌫ 단축키 / 우클릭 "아카이브" |
| 동작 | `archivedAt = now`, 사이드바 트리에서 사라짐 (Archived 섹션에만) |
| 부모 archive 시 자식 | **Cascade archive** (자식 모두 함께) — 복구 시 함께 부활 |
| Undo | 직후 5초 toast "[실행 취소]" / ⌘Z |
| 금지 대상 | Daily 노트 자체, `wiki:*` type |

### 6-3. Hard delete (영구 삭제)

| 항목 | 결정 |
|---|---|
| 진입 경로 | Archived 섹션에서만 접근 가능 |
| 자동 청소 | archive 후 **30일 경과 시 background hard delete** |
| 수동 발동 | Archived 항목 우클릭 → "영구 삭제" → confirm dialog |
| 자식 가진 부모 | **Cascade confirm** — "이 노트와 자식 N개를 모두 영구 삭제합니다. 복구 불가능. [취소] [삭제]" |
| 동작 | catalog 제거 + proof-sdk `DELETE /documents/:slug` |
| 안전망 | git 백업 history 에는 남음 |

### 6-4. 노트 이동 (트리 재배치)

| 항목 | 결정 |
|---|---|
| UI | 노트 항목 더보기(`⋯`) 메뉴 → "이동" → 부모 선택 |
| Daily ↔ Daily 사이 이동 | **자유** (제약 없음) |
| Cycle 방지 | 자기 자신의 자손 아래로 이동 금지 (코드 검증) |
| 데이터 | catalog `parentId` 만 변경, proof-sdk 본문 무영향 |

### 6-5. 엣지 케이스

| 상황 | 처리 |
|---|---|
| 부모 archive 직후 자식만 단독 복원 | 가능, 부모는 archived 유지 |
| Daily 자식 모두 archive → daily 비어있음 | daily 유지 (그날 anchor) |
| 빠른 연속 archive (단축키 연타) | toast 누적, undo LIFO |
| 활성 노트 archive | activeNoteId = 부모 또는 today |
| catalog parentId 무효 (orphan) | 부팅 시 검증, root 로 fallback + 로그 |
| 자정 넘김 직후 | 활성 노트는 어제 daily 유지, today 새로 등장 (사용자가 명시 전환) |

### 6-6. 위키 노트 라이프사이클

- 생성: Memory-writer 자동 (P3) — v1 은 belief 1개만 부트스트랩
- archive/delete: 금지
- 사용자 직접 편집: 가능, source='user' 마크

---

## Q7. 에이전트 세션 정책 ✅

**결정: 활성 노트 1개만 세션 유지 + Copyeditor/Chat 분리 + 즉시 interrupt + 30일 자동 청소.**

### 카파시 위키가 풀어주는 사용자 편안함 (배경)

위키가 모든 세션의 안전망이라 세션 라이프사이클이 사용자 체감에 거의 영향 없음. 따라서 개발 단순함을 우선해도 손해 없음.

| 일반 AI 앱 문제 | 우리 앱에서 해결 |
|---|---|
| AI 가 매번 나를 모름 | 위키에 누적, 매 호출 자동 주입 |
| 글마다 컨텍스트 끊김 | 위키가 모든 노트 관통 |
| AI 답이 일반론 | belief 기반 개인화 |
| 세션 만료 두려움 | 위키가 본체, 세션은 임시 작업 메모리 |
| 노트 천 개 = 노이즈 | AI 는 압축본(위키)만 봄 |
| 설명 매번 반복 | 위키에 박혀있음 |
| AI 가 톤 변형 | 위키에 톤 정의, 위반 즉시 감지 가능 |

### 구체 동작

| 영역 | 동작 |
|---|---|
| Q7-1 세션 정책 | 활성 노트 1개만 메모리에서 작동. 노트 전환 시 이전 세션 종료. 다시 방문 시 새로 시작 (위키 + 본문 읽음) |
| Q7-2 Copyeditor / Chat | 두 독립 세션 (Haiku / Sonnet). 같은 노트 본문 + 위키 읽되 서로의 대화는 모름 |
| Q7-3 노트 전환 시 | 진행 중 HTTP 요청 즉시 abort. 들어올 뻔한 마크는 만들어지지 않음 |
| Q7-4 만료 | 30일 미사용 노트의 sessionId/캐시만 background 청소. 본문/마크/트리 무영향. UI 노출 없음 |

### 사용자 체감 차이

- 노트 전환 직후 첫 idle 응답이 ~1초 느림 (재시작 비용)
- 그 외 모든 동작 동일. 데이터 손실 0.

---

## Q8. 위키 가시성 ✅

**결정: Level C (인용 추적) 지향. v1 에는 데이터 구조 + 사이드바 Wiki 섹션만, UI 표시 형태는 미정.**

### 단계적 도입

| 단계 | 영역 | 무엇 |
|---|---|---|
| **v1 (구조)** | 데이터 | proof-sdk 마크에 메타 필드 추가: `sourceBeliefId`, `sourceWikiSlug`, `reason` |
| **v1 (구조)** | 에이전트 | `suggest_*` 도구 시그니처에 source 인자 추가 |
| **v1 (구조)** | 에이전트 | 시스템 프롬프트에 "가능하면 source 명시" 지시 (best-effort) |
| **v1 (UI)** | 사이드바 | Wiki 섹션 표시. 클릭 시 메인 에디터에 위키 노트 열림 (일반 노트와 동일 흐름) |
| **v1 (UI)** | 인라인/chip 등 | **미정** — 디자인 단계에서 결정 |
| **v1.5+** | UI | hover popover, 활성 chip 등 시각화 추가 (디자인 후) |
| **P3+** | 자동성장 | Memory-writer 정식 가동으로 belief 풍부해짐 → 인용 가시 효과 폭발 |

### 마크 메타 데이터 모델 (v1)

```ts
type SuggestionMarkMeta = {
  // 기존
  kind: 'suggestion'
  by: string                    // 'ai:copyeditor'
  // 추가 (Q8)
  sourceBeliefId?: string       // 'belief:짧은문장선호' 등 식별자
  sourceWikiSlug?: string       // 위키 노트 slug (점프용)
  reason?: string               // 짧은 자연어 설명
}
```

source 누락 시 fallback: 일반 마크로 동작 (UI 가 source 표시 안 함).

### 한계 (인지)

| 한계 | 대응 |
|---|---|
| 모델이 source 항상 명시 안 함 | best-effort. 누락 시 일반 마크 |
| Belief 1개 시기 시각 활성도 낮음 | 위키 자라면서 자연 활성화 |
| 인용된 belief 삭제 시 링크 깨짐 | 위키 archive/delete 금지 (Q2) 로 보호 |

### 위키 편집 진입

사이드바 Wiki 항목 클릭 → 메인 에디터에 위키 본문 열림. 일반 노트와 동일 흐름. 별도 모달 없음 (Q2 통합 카탈로그 결정과 일관).

---

## Q9. 채팅 UX ✅

**결정: 글로벌 채팅 패널 + 명시 컨텍스트 모델 (Context Engineering) + A/B/C 모드 통합 + AI 자율 트리거 없음.**

### 핵심 모델

채팅은 **글로벌 도구** — 어느 노트/페이지에서든 동일 작동. 활성 노트에 종속되지 않음.

```
우측 채팅 패널 구조:
┌─ Context (자동 + 명시) ─────┐
│ 📚 belief              [auto]│
│ 📄 활성 노트            [auto, 토글 OFF 가능]
│ 📄 회의록 4/27          [×]  │  ← 사용자 추가
│ ✂ 드래그한 텍스트        [×]  │  ← 메타데이터 동행
│ + 노트 / + 위키              │
├─ 채팅 메시지 영역 ──────────┤
│                              │
├─ 입력 ─────────────────────┤
│ [...]                  [Send]│
└──────────────────────────────┘
```

### A + B + C 통합 작동

별도 모드 분기 코드 없음. 시스템 프롬프트 + 도구 권한이 모든 모드 허용:

- 사용자가 활성 노트 컨텍스트 둔 채 "이 단락 어때?" → A 글쓰기 보조
- 컨텍스트 비우고 "오늘 점심 추천" → B 자유 대화 (위키는 항상 자동, 사용자 톤/취향 알고 있음)
- AI 가 답변 중 belief 갱신 가치 있으면 `memory.propose_edit` 자율 호출 → C 메모리 인터뷰

### proof-sdk 메타데이터를 AI 컨텍스트로 (차별점)

사용자가 본문 드래그 → 채팅 컨텍스트 추가 시 **단순 텍스트가 아니라 메타데이터 동행**:

```jsonc
{
  "type": "text_fragment",
  "noteId": "...", "noteTitle": "...",
  "from": 142, "to": 218,
  "text": "...",
  "marks": [
    { "kind": "suggestion", "by": "ai:copyeditor", ... ,
      "sourceBeliefId": "belief:짧은문장선호" },
    { "kind": "proofAuthored", "by": "human:user", "range": [142, 200] },
    { "kind": "proofAuthored", "by": "ai:copyeditor", "range": [200, 218] }
  ]
}
```

→ AI 가 글자 단위 provenance, 어느 belief 기반의 제안이 걸려있는지, 사용자/AI 작성 비율까지 알고 답변. **일반 ChatGPT 절대 불가능한 분석.**

### Context Engineering UI

| 기능 | 동작 |
|---|---|
| 자동 컨텍스트 | 위키 (시스템 프롬프트 prepend), 활성 노트 (기본 ON, 토글로 OFF 가능) |
| 노트 추가 | `+ 노트` 버튼 / 슬래시 `/note 회의록` |
| 위키 추가 | `+ 위키` / 슬래시 `/wiki belief` |
| 드래그 텍스트 | 본문 드래그 → 패널 drag-drop / 단축키 **⌘⇧L** |
| 제거 | 칩의 `×` |
| 토큰 카운터 | 칩 옆 (선택, 후순위) |
| Context preset 저장 | v1.5+ |

### 트리거 정책

**AI 자율 트리거 없음** (메모리 인터뷰 등). 사용자가 채팅 열고 입력해야 시작. 사용 패턴 보고 v1.5+ 에서 추가 판단.

### 모델 / Effort 사용자 제어

| 항목 | 결정 |
|---|---|
| 기본 모델 | Sonnet 4.6 |
| 사용자 변경 | **가능** — 채팅 패널에 모델 셀렉터 (Haiku 4.5 / Sonnet 4.6 / Opus 4.7) |
| Effort level | **가능** — low / medium / high / xhigh 중 선택 |
| 영구화 | 마지막 선택 기억 (사용자별, 노트별 아님) |

→ 기존 `agent-settings-chip.tsx` 의 모델/effort 셀렉터를 채팅 패널에도 노출. Copyeditor 와 별개 설정.

### 세션 정책 (Q7-2 일관)

- Copyeditor 세션과 **분리된 독립 채팅 세션**
- 활성 노트 단위로 채팅 세션 살아있음 (활성 노트가 곧 컨텍스트의 일부라)
- 채팅 패널 닫아도 세션 유지, 다시 열면 이어짐
- 노트 전환 시 채팅 세션도 따라 전환 (이전 노트 진행 중 query interrupt)
- 30일 미사용 세션 background 청소

### 도구 권한 (v1)

| 도구 | 우선 |
|---|---|
| `note.search(q)` / `note.read(slug)` | v1 |
| `wiki.search(q)` / `wiki.read_page(slug)` | v1 |
| `suggest_replace/insert/delete` (활성 노트) | v1 |
| `memory.propose_edit` (간단 버전) | v1, P3 정식 |
| `comment.add` (활성 노트) | v1.5 (PR 2 합류) |

---

## Q10. 디렉터리/코드 재구성 ✅

**결정: PR B (AppShell + Sidebar) 에서 main/renderer 모두 한 번에 feature-folder 재구성.**

### 새 구조

#### Main process

```
src/main/
├─ index.ts                  (IPC 라우팅만)
├─ proofServer.ts            (proof-sdk subprocess)
├─ proofClient.ts / proofApi.ts
├─ notes/
│   ├─ noteCatalog.ts
│   ├─ noteService.ts
│   ├─ noteTypes.ts
│   └─ catalogMigration.ts
├─ wiki/
│   └─ wikiService.ts
├─ agent/
│   ├─ copyeditorService.ts
│   ├─ chatService.ts
│   ├─ agentSessionStore.ts
│   ├─ agentSettings.ts
│   └─ claudeRuntime.ts
├─ auth/
│   └─ oauthService.ts
├─ markService.ts
├─ backup/
│   ├─ markdownExporter.ts
│   └─ gitBackup.ts
└─ ipc/
    ├─ notes.ts / doc.ts / wiki.ts / agent.ts / chat.ts / auth.ts
```

#### Renderer

```
src/renderer/src/
├─ App.tsx                   (얇음, AppShell 위임)
├─ main.tsx
├─ index.css
├─ layout/
│   ├─ AppShell.tsx
│   ├─ TitleBar.tsx
│   ├─ Sidebar.tsx
│   └─ ContextPanel.tsx
├─ pages/
│   ├─ NoteView.tsx
│   ├─ EmptyState.tsx
│   └─ BootScreen.tsx
├─ notes/
│   ├─ NoteList.tsx / NoteListItem.tsx
│   ├─ NoteTree.tsx
│   ├─ NoteHeader.tsx
│   └─ useNotes.ts / useActiveNote.ts
├─ editor/
│   ├─ MilkdownEditor.tsx
│   ├─ markPlugin.ts / authoredMark.ts / authoredTracker.ts
│   ├─ textRange.ts
│   └─ commands/
├─ chat/
│   ├─ ChatPanel.tsx
│   ├─ ContextChips.tsx
│   ├─ MessageList.tsx
│   ├─ ChatInput.tsx
│   ├─ ModelSelector.tsx
│   └─ useChat.ts
├─ wiki/
│   └─ WikiSidebarSection.tsx
├─ agent/
│   ├─ AgentSettingsChip.tsx
│   └─ MarkActionsChip.tsx
├─ auth/
│   ├─ SignInPanel.tsx
│   └─ AccountMenu.tsx
├─ components/
├─ hooks/
├─ lib/
└─ state/
    ├─ notesStore.ts
    ├─ chatStore.ts
    └─ layoutStore.ts
```

### 적용 시점

- PR A (카탈로그 백엔드): main 일부만 재구성 (notes/, ipc/)
- **PR B (AppShell + Sidebar)**: renderer 전체 + main 잔여 한 번에 재구성
- 이후 PR 들은 새 구조 위에서 기능 추가만

### Reliability 보장

- mv 는 logic 변경 0
- TypeScript 타입체크 + import 경로 자동 갱신 (IDE refactor) 으로 충돌 방지
- PR B 의 acceptance: 빌드 성공 + 기존 동작 모두 유지 (수동 smoke test 체크리스트)

---

## Q11. 상태관리 ✅

**결정: Zustand 도입. 글로벌 공유 상태만 store, 로컬 상태는 useState 유지.**

### 분리 원칙

| 상태 종류 | 도구 |
|---|---|
| 한 컴포넌트 내부 (입력 draft, hover, popover 열림 등) | **useState** (그대로) |
| 여러 컴포넌트 / IPC 응답 / 단축키가 건드리는 글로벌 | **Zustand store** |

→ "한 번에 다 옮김" 은 안티패턴. v1 이 끝나도 useState 가 70-80% 유지됨.

### Store 설계

| Store | 도입 시점 | 내용 |
|---|---|---|
| `layoutStore` | PR B | 사이드바/우측패널 토글 상태 |
| `notesStore` | PR B | 카탈로그, activeNoteId, provider/ydoc 라이프사이클 |
| `chatStore` | PR E | 채팅 메시지, 컨텍스트 칩, 모델/effort 선택 |

각 PR 에서 **그 PR 의 공유 필요 상태만** store 화. 점진이 아니라 "용도별 분리".

### 사용 패턴

```ts
// state/notesStore.ts
export const useNotesStore = create<NotesState>((set) => ({
  catalog: [],
  activeNoteId: null,
  setActive: (id) => set({ activeNoteId: id }),
  upsert: (note) => set((s) => ({ /* ... */ })),
}))

// 컴포넌트 (selector 로 자동 재렌더 최적화)
const activeId = useNotesStore((s) => s.activeNoteId)

// IPC 응답 등 외부에서
useNotesStore.getState().upsert(noteFromMain)
```

Provider 중첩 0, prop drilling 0.

### 채택하지 않은 옵션

- React Context only: 6+ 도메인 분리 시 Provider 중첩 + 재렌더 방어 코드 부담
- Jotai: 미세 atom 단위가 우리 규모에 과함
- Redux Toolkit: 베타급에 표준화 비용 과함

---

## Q12. 구현 PR 순서 ✅

**결정: A → B → C → D → E → F → G. 총 v1 ≈ 4-5주 1인 작업.**

### PR 시퀀스

#### PR A — 카탈로그 백엔드 + 마이그레이션
- `main/notes/`: noteCatalog.ts, noteService.ts, noteTypes.ts, catalogMigration.ts
- 기존 `doc.json` + `wiki.json` → `catalog.json` (1회, idempotent)
- IPC `note:list/create/rename/archive/restore/delete/pin/move`
- `main/backup/` 토대 (markdownExporter + gitBackup)
- 마크 메타 필드 추가 (sourceBeliefId, sourceWikiSlug, reason)
- **renderer 무변경** — 기존 단일 글 흐름은 catalog 첫 노트로 위장하여 동작 유지

**Acceptance**: 기존 앱 동작 100% 유지, 카탈로그 파일 생성 확인, 마이그레이션 idempotent.  
**추정**: 2-3일.

#### PR B — AppShell + Sidebar 트리 + 디렉터리 재구성
- Q10 의 main/renderer 전체 디렉터리 재구성 (한 번에)
- `layoutStore` + `notesStore` 도입 (Zustand)
- AppShell (좌 사이드바 + 중 에디터 + 우 패널 자리)
- Sidebar: Today / Recent / Older / Wiki / Tags 섹션
- NoteTree (무제한 깊이, indent 가이드, expand/collapse)
- 토글 단축키 (⌘1 / ⌘. / ⌘\)
- **노트 전환 X** — 항상 첫 노트 활성 (PR C 까지 보류)

**Acceptance**: 사이드바 노트 목록 보임, 토글 작동, 빌드/타입체크 통과.  
**추정**: 4-5일.

#### PR C — 노트 전환 + 라이프사이클
- `useActiveNote` 훅: provider/ydoc destroy + 재생성, agent session interrupt + 재attach
- 사이드바 노트 클릭 → 활성 전환
- 에디터 상단 breadcrumb
- 빠른 연속 전환 디바운스 (50ms)

**Acceptance**: 두 노트 사이 전환 시 메모리 누수 없음, 마크/본문 손실 없음.  
**추정**: 2-3일.  
**핵심**: 이 PR 부터 **첫 사용자 가치** — 여러 노트 자유 전환.

#### PR D — 노트 CRUD UX
- `+ New` (Daily 자동 / 정식 / 자식)
- 슬래시 `/note` 명령
- 더보기 메뉴: 이름변경, 이동, 아카이브, 영구삭제
- Archive (⌘⌫) + 5초 undo toast
- Hard delete (cascade confirm)
- 30일 자동 청소 background

**Acceptance**: Q6 엣지 케이스 표 모든 시나리오 수동 검증.  
**추정**: 3-4일.

#### PR E — 채팅 패널 + Context Engineering
- ChatPanel / ContextChips / MessageList / ChatInput / ModelSelector
- `chatStore` (Zustand)
- 자동 컨텍스트 (위키 + 활성 노트, 토글 가능), 명시 추가 (`+ 노트` / `+ 위키` / 드래그 ⌘⇧L)
- 드래그 시 proof-sdk 메타데이터 동행 (provenance + 마크 메타)
- 모델/Effort 셀렉터 (사용자별, 노트별 아님)
- `main/agent/chatService.ts` (Sonnet 기본, 도구 v1 셋)

**Acceptance**: 본문 드래그 → 칩 추가 → 메타 포함 전송 검증. 모델 변경 시 응답 모델 일치.  
**추정**: 5-7일.

#### PR F — 위키 가시성 마무리
- 사이드바 Wiki 섹션 정식 (belief 클릭 → 메인 에디터)
- WikiModal 제거
- Memory-writer 가 belief 갱신 시 마크 메타 sourceBeliefId 박힘 (수신만, 시각화는 v1.5+)

**Acceptance**: belief 편집이 일반 노트와 동일 흐름.  
**추정**: 1-2일.

#### PR G — Bulk Actions + Comment 마크 + 호버 액션
roadmap.md PR 1/2/3 흡수:
- shadcn 정리 + 마크 카운터 chip + Bulk accept/reject
- proofComment 마크 + popover + 추가/해결 흐름
- 마크 hover 액션 바 (React Portal)

**추정**: 3-4일.

### 의존성 그래프

```
PR A ──▶ PR B ──▶ PR C ──▶ PR D ──▶ PR E
            │                   │
            └─▶ PR F (병렬 가능)

PR G 는 PR D 이후 어느 시점이든
```

### 단계별 사용자 가치

| PR | 사용자가 새로 할 수 있는 것 |
|---|---|
| A | (없음 — 백엔드만) |
| B | 사이드바 보임, 트리 시각화 (1개 노트) |
| **C** | **여러 노트 자유 전환** — 첫 사용자 가치 |
| D | 노트 만들기/지우기/정리 (정식 멀티노트 앱) |
| E | 채팅 + Context Engineering |
| F | 위키 정식 편집 |
| G | 마크 일괄 처리, 코멘트, 호버 |

### v1 마무리 후 (v1.5+ / P3)

- 위키 가시성 UI (Q8): hover popover, 활성 chip, 인용 표시
- 백링크 forward UI (v1.5)
- Memory-writer 정식 (P3)
- 채팅 트리거 정책 재검토 (사용 패턴 보고)
- 멀티 디바이스 (proof-sdk 서버 원격화)

---

## 부록 — 결정 요약 한 표

| Q | 결정 |
|---|---|
| Q1 제품 좌표 | Bear-like 장문 글쓰기 (메인) + Obsidian-lite atomic (위키) |
| Q2 위키-노트 관계 | 한 catalog 통합 + 카파시식 write-ownership 분리 |
| Q3 organization | Daily 트리 무제한 + 태그 후가공 (Promote 없음) |
| Q4 동기화 | v1 단일 디바이스 + 마크다운 git 백업 (멀티 디바이스 deferred) |
| Q5 레이아웃 | 2-pane + 우측 컨텍스트 패널 토글 (v1 우측 = 채팅) |
| Q6 라이프사이클 | Archive (⌘⌫, undo) → Hard delete (cascade confirm) → 30일 자동 |
| Q7 세션 | 활성 노트만 + Copyeditor/Chat 분리 + interrupt + 30일 청소 |
| Q8 위키 가시성 | Level C 지향. v1 = 데이터 구조 + 사이드바 섹션. UI 시각화는 미정 |
| Q9 채팅 UX | 글로벌 + Context Engineering + A/B/C 통합 + AI 자율 트리거 X + 모델/Effort 사용자 제어 |
| Q10 디렉터리 재구성 | PR B 에서 한 번에 feature-folder |
| Q11 상태관리 | Zustand 글로벌만, 로컬은 useState |
| Q12 PR 순서 | A → B → C → D → E → F → G (v1 ≈ 4-5주) |

---

## 다음 단계

이 문서를 바탕으로 **PR A (카탈로그 백엔드 + 마이그레이션)** 부터 착수.

PR A 가 renderer 무변경 + idempotent 마이그레이션이라 가장 위험이 낮고, 후속 PR 의 토대가 됨.

