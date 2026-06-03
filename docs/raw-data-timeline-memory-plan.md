# Raw Data → 타임라인 → 메모리 → 클론 계획

> 작성일: 2026-05-31
> 상태: 설계 논의 단계 (구현 시작 전)
> 한 줄 요약: 흩어진 raw data를 시간축으로 묶어 "메모리"로 만들고, 그 메모리가 곧 클론의 바탕 DB가 되는 구조.

---

## 1. 제품 컨셉

여기저기 흩어진 정량/정성 데이터(주식 매매, 헬스 트래커, 수면, 손으로 쓴 메모)를
MCP/API로 자동으로 끌어와서, **시간 순서로 한 줄에 꿰어 보여주는 노트앱**.

핵심 가치는 단순 저장이 아니라 **"메모리화"** — raw를 의미로 압축하고,
그 압축된 기억이 최종적으로 **개인 AI 클론의 연료**가 된다.

---

## 2. 핵심 설계 원칙

### 2.1 narrow waist — 모든 데이터를 하나의 공통 단위로

어떤 소스든 가져올 때 **겉포장(envelope)을 통일**한다. 속 내용만 자유.

```
Entry {
  id            // 안정적 식별자 (= 중복제거 키)
  ts            // 사건이 "일어난" 시각  ← 타임축의 척추
  ingested_at   // 우리가 "가져온" 시각  (백필/지연 데이터 때문에 ts와 분리 필수)
  source        // "robinhood" | "whoop" | "manual"
  kind          // "trade" | "workout" | "note"
  payload       // 원본에 가까운 JSON 본문 (자유)
  summary       // 한 줄 요약
  entities[]    // 링크 가능한 키: "AAPL", "squat"
  refs[]        // 다른 Entry로의 연결
}
```

- **겉은 고정(시각/출처/종류/요약), 속(payload)은 자유** → 유연함의 핵심.
- 시각이 두 개(bitemporal): 정렬은 `ts`(사건 시각) 기준. 이걸 한 필드로 뭉개면 못 고침.
- schema-on-read + 얇은 타입 봉투. 완전 자유 = 검색 불가, 완전 고정 = 새 소스 못 받음. 그 사이 절충.

**[확정] payload는 커넥터별로 정의 — "저장"과 "꺼내기"를 분리한다:**

- **저장**: 프로바이더 응답을 **있는 그대로 통째로** payload에 박는다. 프로바이더 문서 읽고 주는 정보 전부. → 새 필드는 그냥 딸려 들어오고, 매핑 유지보수 부담 없음.
- **꺼내기**: 그중 **지금 당장 계산·검색에 필요한 몇 개만** 공통 포장지(summary/entities/자주 쓰는 수치)로 끌어올린다. 나중에 필요하면 저장된 원본에서 재추출.
- **이름 통일**: payload는 프로바이더 원본 용어 그대로(amount/value/qty…), 공통 포장지로 끌어올릴 때만 내 용어로 통일 → 여러 소스 가로지른 계산 가능.
- **민감정보 주의**: 인증토큰·내부ID 같은 건 payload에 저장하지 않는다.

### 2.2 사실과 해석을 절대 섞지 않는다

```
1단계: 사실을 그대로 쌓기   (3/5 애플 10주 매수 — 영원히 안 변함)
2단계: 사실을 해석하기      (수익 계산, AI 요약 — 언제든 바뀜)
```

해석을 저장 단계에 섞으면, 계산식/AI 방식을 바꿀 때 과거 데이터가 망가진다.
→ **사실은 금고에 그대로, 해석은 그 위에서 매번 새로 뽑는다.**
→ 외부 원본 raw는 번역해서 넣더라도 **원본 그대로도 같이 보관** (재현 가능성).

### 2.3 두 가지 저장 형태가 공존한다

| 저장소 | 무엇 | 형태 |
|---|---|---|
| **A. 구조화 이벤트 창고** (신규) | 외부에서 온 또렷한 데이터 (주식/운동/수면) | 표/레코드 (`events.db`). 계산·검색 최적 |
| **B. 마크다운 vault** (현재 제품) | 손으로 쓴 글, 위키 페이지, wrapup 결과물 | `.md` + `.meta.json` 사이드카 |

> ⚠️ 외부 구조화 데이터를 억지로 마크다운 글로 우겨넣지 말 것. 숫자는 표(A)에, 글은 vault(B)에.

데일리 화면은 **저장소가 아니라 A·B를 시각 기준으로 합쳐 보여주는 "창문".**

---

## 3. 메모리 3층 구조

```
3층  클론        ← 1·2층을 읽어서 사용자처럼 답하고 행동
2층  파생/요약    ← 매일 1층을 압축해서 "의미"를 붙임
1층  raw 이벤트    ← 사실 그대로 쌓기 (events.db + 손메모)
```

2층 파생물도 다시 같은 타임라인에 저장된다 → **기억의 피라미드** (밑은 자잘하고 많고, 위는 압축되고 적음). 클론은 평소 위층 요약만 읽고, 필요할 때만 아래층 원본으로 파고든다.

### 3.1 두 방향의 압축 — wrapup과 위키는 형제

같은 raw에서 **두 축으로** 갈라져 나온다:

```
                        ┌─→ wrapup    : 시간축 압축 (오늘 것 전부 → 하루 요약)   ["일화 기억"]
raw 타임라인 (1층) ──────┤
                        └─→ 위키ingest : 주제축 압축 (Sarah 언급 전부 → Sarah 페이지) ["의미 기억"]
```

- **위키 = 의미 기억(semantic)**: "내 매매 원칙이 뭐였지?" → 시간 무관, 누적 지식. **이미 구현됨.**
- **wrapup = 일화 기억(episodic)**: "지난주에 왜 불안했지?" → 특정 시점 스냅샷. **미구현.**
- 클론은 둘 다 필요. 하나만 있으면 반쪽.
- `system:log`은 wrapup이 아님 — ingest 작업 영수증(메타데이터)일 뿐.

### 3.2 데이터 한 점의 일생

```
1. 발생   주식앱에서 5/31 9:30 애플 10주 매수
2. 변환   공통 포장지로 번역 {ts, source, kind, summary, payload}
3. 저장   events.db에 한 줄 추가 (원본도 같이 보관)
4. 표시   데일리 타임라인에 📈로 뜸 (A+B 합쳐서)
5. 압축   ├─ wrapup: "오늘 +12만" (시간축)
          └─ 위키:   AAPL전략 페이지 갱신 (주제축)
6. 회상   클론이 요약 먼저 → 필요시 events.db 원본까지 파고듦
```

---

## 4. wrapup 카드 설계 (정량 + 정성)

```
┌─ 2026년 5월 31일 ────────────────┐
│  📊 오늘의 숫자                   │ ← 정량: events에서 계산 (Python 수준으로 쉬움)
│   · 매매 수익  +12만원            │
│   · 운동      스쿼트 50kg         │
│   · 수면      6시간 12분          │
│                                  │
│  ✍️ 오늘의 이야기                 │ ← 정성: 그날 이벤트+메모를 LLM에 → 서사 생성
│   "장 초반 불안해서 손절했는데    │
│    돌아보니 성급했다..."          │
└──────────────────────────────────┘
```

- wrapup은 새 시스템이 아니라 **기존 ingest 기계 재활용** + 출력 모양만 추가.
- 클론을 "사용자답게" 만드는 건 정성 쪽 (숫자는 누구나 비슷, why/감정이 개인 패턴).
- 저장 위치: 데일리 노트 자체 또는 데일리에 딸린 요약 문서.

**[확정] wrapup = 마크다운 기반 + 살아있는 차트 카드:**

- vault가 이미 마크다운이라 새 저장방식 없이 끼어듦. 차트는 기존 **card NodeView 구조**(ADR 2026-05-23) 위에서 events.db를 읽어 그리는 또 하나의 카드 노드.
- **글(정성) = frozen 마크다운**: AI가 쓴 그날의 이야기, 스냅샷으로 박아둠.
- **숫자·차트(정량) = events.db를 가리키는 살아있는 참조**: 숫자를 텍스트로 박지 않는다.
  - 이유 ①: 데이터 정정/지연정산 시 자동으로 고쳐짐 (사실/해석 분리 원칙).
  - 이유 ②: 클론(LLM)은 마크다운은 읽지만 차트 **그림(픽셀)은 못 읽음** → 차트 밑에 숫자가 텍스트/구조로 같이 있어야 클론이 읽음. **이미지로 굽지 말 것.**

### 미결정 사항

- **(나중) 멀티플랫폼 UI 스택**: iOS를 Tauri로(코드 재사용) vs Swift 네이티브로(손맛). 지금 못 박을 필요 없음 — 데이터 계약(events.db 스키마 + vault 형식)을 플랫폼 중립으로 두면 나중에 자유 선택, 되돌릴 수 있는 결정.
- **(나중) 기기 간 동기화**: Mac ↔ iPhone DB 동기화. 단일 사용자라 CRDT 불필요, 단순 동기화(iCloud 파일 / libsql·Turso / 작은 sync 서버)로 충분. iOS 마일스톤 때 결정.
- **(나중) 클론 단계**: 의미검색/임베딩 인프라(`sqlite-vec` 등), 기억 연결(refs) 방식.

### 확정된 결정 (resolved)

- 메모리 범위: A(모아보기) 토대 위에 B(수익계산)·C(AI서사) 얹기.
- payload는 커넥터별 정의 + 프로바이더 원본 통째 저장 + 칸은 필요한 것만 끌어올림 (§2.1).
- wrapup = 마크다운(frozen 글) + events.db 참조 살아있는 차트 카드 (이미지 X) (§4).
- 외부 데이터는 데일리 타임라인으로 들어와 wrapup·위키 둘 다 먹임.
- 또렷한 숫자는 events.db, 글은 마크다운 vault.
- **위키 ingest 입력**: raw를 메인으로 읽되(디테일 보존) wrapup도 옆에 참고. "raw만"으로 못 박지 않음.
- **events.db 실체**: **SQLite (Rust 백엔드, rusqlite/sqlx)**. JSON1로 payload 그대로 저장, 나중에 `sqlite-vec`로 클론 의미검색까지 한 엔진. vault 폴더 안에 둠.
- **화면 형태**: **데일리 문서 안 블록**으로 섞음 (별도 피드 X). 기존 card NodeView 재사용, events.db를 라이브 참조하는 카드 노드. wrapup이 데일리노트 하나만 읽으면 그날 전부가 됨. 화면 정돈은 접기/필터로.
- **스케줄링**: 외부 데이터는 소스가 지원하면 push, 아니면 **주기 polling**(데스크탑은 push 불가). wrapup은 **밤 10~11시 자동 초안 → 유저가 수정** 가능.
- **첫 커넥터**: **GitHub** (§9). 애플헬스는 macOS 데스크탑 직접 접근 불가 → **iOS 마일스톤으로 연기**.
- **정성 wrapup 입력**: 그날 생성된 **전부**(이벤트 + 데일리노트/손메모). 이벤트가 데일리노트 블록으로 있으니 데일리노트 하나 읽으면 자동 포함.

---

## 5. 현재 코드베이스 상태 진단 (2026-05-31 기준)

| 항목 | 상태 |
|---|---|
| main 대비 | **98커밋 앞섬, 아직 머지 안 됨** |
| 저장 계층 | 바로 최근 갈아엎고 안정화 (Phase I/J/K: 디스크 race 수정, Yjs 제거) |
| 리뷰/마크 시스템 | 방금 끝남 (최근 ~10커밋 거의 전부 review) |
| ingest 파이프라인 | 최근 agentic loop으로 재작업, 6개 파일로 격리됨 |
| events.db / 커넥터 / wrapup | **아직 0줄. 완전 신규** |
| 테스트 | 13개 (vitest) |

> 저장 구조: 마크다운 vault + `.meta.json` 사이드카 + `bodyMarkdown` 캐시. (Yjs/CRDT는 제거됨)

**한 줄 요약: 토대를 막 새로 깐 직후인데 아직 main에 안 올라간 상태 (페인트가 안 마른 집).**

---

## 6. 의존성 지도 (엔지니어 관점)

### A. 새 작업이 "기대고 있는" 것 (상류 의존성)

1. **저장 source-of-truth 모델** (위험 中) — events.db가 마크다운 vault와 어떻게 공존? watcher/flush 흐름에 합류 vs 별도 생명주기? 방금 "디스크 날아가던 race"를 고친 직후라 같은 함정 주의.
2. **ingest 파이프라인** (위험 中) — wrapup이 재활용. 또 바뀌면 wrapup이 깨짐. 다행히 6파일로 격리돼 충격 범위 좁음.
3. **pendingChanges/리뷰/apply 경로** (위험 高) — 구조화 이벤트가 위키 제안을 만들면 결국 이 리뷰 시스템 통과. 최근 가장 많이 출렁인 곳 = 아직 증명 안 됨.
4. **데일리 노트 표면** (위험 高, 실제 공백) — 지금 데일리는 100% 마크다운 글. 구조화 이벤트(📈카드)는 글이 아님 → **글 아닌 블록 렌더 방법을 새로 만들어야** 함.

### B. 새 작업이 "새로 끌고 오는" 위험 (고유 의존성)

1. **커넥터 계층 (MCP/API)** — 가장 위험. 외부 인증키, 호출 제한, 멱등성, 증분 동기화. 외부 데이터는 본질적으로 불안정(서버 다운/포맷 변경/지연). **CLAUDE.md "에러 없는 wellmade" 원칙과 정면 긴장** → 외부가 죽어도 앱은 멀쩡해야 한다는 설계가 처음부터 필요.
2. **스케줄링/백그라운드** — 외부 데이터 언제 당겨오나? wrapup 언제 도나?
3. **events.db 스키마 (갈래 1)** — 모든 걸 막는 관문. 이거 정해야 1·2번 시작.
4. **(클론) 의미검색/임베딩** — 완전 신규 인프라, 한참 뒤.

### 가장 큰 리스크: 98커밋 미머지 탑

검증 안 된 탑 위에 검증 안 된 탑을 또 쌓는 격. 뭐 하나 깨지면 추적이 지옥.

---

## 7. 권장 순서

```
0. (먼저) 지금 브랜치를 main에 착지시키거나,
   최소한 저장·ingest·리뷰 표면을 "고정 기준선"으로 동결.   ← 페인트부터 말리기

──── 안전지대 (토대 출렁여도 영향 적음) ────
1. events.db 포장지 스키마 설계 (갈래 1)        ← 지금 해도 안전, 독립적
2. 커넥터 1개 + events.db 저장 (수직 슬라이스)
   - 외부 죽어도 앱 멀쩡한 설계 포함
   - 실데이터로 끝까지 관통 (합성 데이터 X)
3. 데일리에 이벤트 카드 렌더 (글 아닌 블록)

──── 토대 착지 후 ────
4. wrapup — ingest 재활용 (정량 먼저 → 정성)
5. 의미 검색 + 기억 연결 (임베딩, refs)
6. 클론 — 피라미드를 읽고 답함 (요약 먼저, 필요시 원본)
```

**원칙: 프레임워크 먼저 만들지 말고 수직 슬라이스 먼저.** 소스 1개를 끝까지 관통 → 2번째 소스를 붙여봐야 추상화가 맞는지 검증됨. 만능 틀을 먼저 만들면 거의 망함.

---

## 8. 각 단계 검증 기준 (verify)

| 단계 | verify |
|---|---|
| 1 | events.db에 한 종류(예: 주식) 레코드가 공통 포장지로 들어간다 |
| 2 | 외부 소스가 죽어도 앱이 멀쩡하다 + 실제 내 데이터가 저장된다 |
| 3 | 데일리 타임라인에 손메모와 이벤트 카드가 시각 기준으로 섞여 뜬다 |
| 4 | 매일 자동으로 그날 wrapup 카드(숫자+서사)가 생긴다 |
| 5 | "불안했던 날들" 같은 의미 질문으로 과거가 끌려나온다 |
| 6 | 클론이 요약을 먼저 보고, 필요하면 원본을 파고들어 답한다 |

---

## 9. 첫 커넥터 스펙: GitHub

데이터 풍부 + API가 가장 깔끔해서 수직 슬라이스용 첫 타자로 선정.

### 9.1 무엇을 가져오나 (scope)

| kind | 데이터 | 1차 슬라이스 |
|---|---|---|
| `commit` | 커밋 메시지, 레포, 시각, +/- 라인수 | ✅ 포함 |
| `pr_opened` / `pr_merged` | PR 제목, 레포, 시각 | ✅ 포함 |
| `review` | 내가 남긴 리뷰 | ⏳ 나중 |
| `issue` | 연/닫은 이슈 | ⏳ 나중 |
| `release` | 릴리스 태그 | ⏳ 나중 |

→ **1차는 commit + PR만.** 나머지는 같은 틀에 추가만.

### 9.2 커넥터 구조

```
GitHubConnector {
  auth()              // PAT 토큰 확보
  fetch(watermark)    // 마지막 이후 새 활동만 → raw[]
  map(raw) → Entry[]  // 공통 포장지로 번역
}
```

- **① 인증**: Personal Access Token(PAT). OAuth 절차 불필요. ⚠️ 토큰은 events.db/payload에 저장 X → **OS 키체인**(Tauri secure storage).
- **② 가져오기 (API)**:
  - 1차(단순): `GET /users/{me}/events` 한 방. 시간순. PushEvent→commit, PullRequestEvent→PR. 한계: 최근 90일/300건/공개활동 위주 — 첫 슬라이스엔 충분.
  - 2차(완전성): `GET /search/commits?q=author:me sort:committer-date` + GraphQL `contributionsCollection` → 비공개 레포 + 전체 히스토리 백필.
- **③ 증분 동기화 (watermark)**: `source=github`의 마지막 처리 지점(event id 또는 ts) 저장. 폴링 때 그보다 새것만 채택. **조건부 요청(ETag)** → 변화 없으면 304, rate limit 소모 0.
- **④ 멱등성(중복 제거)**: 안정적 id 사용. Entry id = `github:commit:<sha>`, `github:pr:<nodeId>`. 두 번 가져와도 덮어쓰기.

### 9.3 공통 포장지 매핑 (예시)

```json
{
  "id": "github:commit:a1b2c3d",
  "ts": "2026-05-31T14:22:00Z",        // 커밋 author date (사건 시각)
  "ingested_at": "2026-05-31T22:00:05Z",
  "source": "github",
  "kind": "commit",
  "summary": "fix(review): 멀티에딧 데이터 손실 방지",  // 메시지 첫 줄
  "entities": ["manila-v1", "TypeScript"],          // 레포, 언어
  "refs": ["github:pr:8842"],                        // 속한 PR
  "payload": { "...깃헙 API 원본 응답 통째로..." }    // §2.1: 원본 그대로
}
```

### 9.4 신뢰성 설계 ("에러 없는 wellmade" 원칙)

- 깃헙 다운/네트워크 끊김 → 커넥터만 조용히 실패, 앱 멀쩡, 다음 폴링 재시도 (크래시 X).
- 부분 실패 → watermark로 중간부터 재개.
- 토큰 만료 → "다시 연결" 상태 명확 표시, 데이터 조용한 누락 금지.
- rate limit → 인증 5000회/시간(개인 스케일 넉넉), ETag로 더 절약.

### 9.5 폴링

- 데스크탑은 깃헙 push(webhook) 수신 불가 → **앱 켤 때 + 주기(30분~1시간) 폴링.** ETag로 변화 없으면 비용 0.

### 9.6 wrapup / 위키 연결

- wrapup(정량): "오늘 커밋 12개, 레포 3곳, PR 2개 머지" — events.db 라이브 참조 차트.
- 위키(주제축): 레포/프로젝트 페이지가 자동 누적.

### 9.7 1차 슬라이스 (딱 이만큼)

```
1. PAT 키체인에 저장
2. /users/me/events 폴링 → commit + PR만 추림
3. 공통 포장지로 map → events.db 저장 (id로 중복제거)
4. 데일리노트에 커밋 카드로 렌더 (블록)
5. verify: 오늘 내 커밋이 데일리 타임라인에 뜬다 + 깃헙 꺼도 앱 멀쩡
```

이게 되면 "포장지 + 저장 + 렌더" 전체 파이프라인 1회 관통. 다음 Oura/Whoop를 2번째로 붙여 틀의 유연성 검증.

---

## 10. 1차 슬라이스 코드 수준 도면

원칙: **저장(표)은 세 쓰임새(표시·숫자·검색·프로젝트별)를 한 번에 다 받치게** 만든다. 화면 기능만 순서대로. 원본은 payload에 통째 보관하므로 미래 쓰임새는 안 막힘.

### 10.1 events 테이블 스키마

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,   -- "github:commit:<sha>" / "github:pr:<nodeId>" (멱등성)
  ts          TEXT NOT NULL,      -- ISO8601, 사건 시각 (정렬·집계의 척추)
  ingested_at TEXT NOT NULL,      -- 가져온 시각 (bitemporal)
  source      TEXT NOT NULL,      -- "github"
  kind        TEXT NOT NULL,      -- "commit" | "pr_opened" | "pr_merged"
  summary     TEXT NOT NULL,      -- 한 줄 요약 (메시지 첫 줄 / PR 제목)
  entities    TEXT,               -- JSON 배열 ["manila-v1","TypeScript"]
  refs        TEXT,               -- JSON 배열 ["github:pr:8842"]
  payload     TEXT NOT NULL       -- 깃헙 API 원본 통째 (JSON). 줄수 등 전부 여기
);

CREATE INDEX idx_events_ts          ON events(ts);            -- 타임라인·날짜별 집계
CREATE INDEX idx_events_source_kind ON events(source, kind);  -- 종류별 필터

-- 검색(쓰임새 6): summary 전문검색
CREATE VIRTUAL TABLE events_fts USING fts5(summary, content='events', content_rowid='rowid');
-- (events INSERT/DELETE 시 트리거로 fts 동기화)
```

> 프로젝트별 묶기(쓰임새 4)는 `entities` JSON을 `json_each`로 풀어 조회. 데이터가 커져 느려지면 그때 `event_entities(event_id, entity)` 조인 테이블로 승격.

### 10.2 보조 테이블 — 커넥터 동기화 상태

```sql
CREATE TABLE connector_state (
  source     TEXT PRIMARY KEY,  -- "github"
  watermark  TEXT,              -- 마지막 처리 지점 (event id 또는 ts)
  etag       TEXT,              -- 조건부 요청용 (변화 없으면 304)
  updated_at TEXT
);
```

### 10.3 파일 구조

**프론트엔드 (`apps/writer-tauri/src/`)**

```
connectors/                  ← 신규
  types.ts                   ← Entry(공통 포장지) 타입 + Connector 인터페이스
  registry.ts                ← 커넥터 등록·폴링 실행
  github/
    index.ts                 ← GitHubConnector 조립 (auth/fetch/map)
    fetch.ts                 ← /users/me/events 호출 + ETag/watermark
    map.ts                   ← 깃헙 raw → Entry 변환
    types.ts                 ← 깃헙 응답 타입 (필요 최소)
lib/
  eventsDb.ts                ← Rust invoke 래퍼 (insert / query / search)
state/
  eventsStore.ts             ← events 조회·구독 (zustand, docsStore 패턴 따름)
editor/
  EventCardNode/             ← 데일리에 박히는 이벤트 카드 (기존 card NodeView 재사용)
```

**백엔드 (`apps/writer-tauri/src-tauri/src/`)**

```
events/
  mod.rs
  db.rs                      ← SQLite 연결·마이그레이션·insert/query
  commands.rs                ← #[tauri::command] events_insert / events_query / events_search
secrets.rs                   ← OS 키체인에 PAT 저장/조회
```

> events.db 파일 위치: vault 폴더 안 (예: `<vault>/events.db`) → "한 vault = 전부" 원칙 유지.

### 10.4 데이터 흐름 (한 바퀴)

```
registry(폴링)
  → github/fetch.ts   : GET /users/me/events (watermark 이후, ETag)
  → github/map.ts     : raw → Entry[] (id, ts, summary, entities, payload…)
  → lib/eventsDb.ts   : invoke("events_insert", entries)   [id 중복은 무시/덮어쓰기]
  → src-tauri events/ : SQLite UPSERT + connector_state 갱신
  → eventsStore       : 변경 구독 → 데일리에 EventCardNode 렌더
```

### 10.5 각 칸이 받치는 쓰임새

| 쓰임새 | 쓰는 칸 |
|---|---|
| 1 타임라인 표시 | `ts`, `summary`, `entities`(레포), payload(링크) |
| 2 wrapup 숫자 | `ts`(날짜), `kind`, payload(줄수) 집계 |
| 4 프로젝트별 | `entities` (json_each) |
| 6 검색 | `events_fts(summary)` |
| 3·5·7 (나중) | payload 통째 보관으로 안 막힘 |

### 10.6 화면 만드는 순서 (데이터는 이미 다 있음)

```
숫자(제일 쉬움) → 시간순 표시 → 검색 → 프로젝트별
```
