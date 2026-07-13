# 외부 데이터 수집 계획 (Gmail · GitHub · OS Context)

> 작성일: 2026-07-13
> 상태: 설계 논의 1차 정리 (구현 시작 전)
> 한 줄 요약: 흩어진 외부 데이터를 이미 깔린 커넥터 배관(events.db)에 같은 방식으로 쌓고, "저장"과 "노트로 보여주기"를 분리한다.

관련 문서: [`raw-data-timeline-memory-plan.md`](./raw-data-timeline-memory-plan.md) · [`github-integration-plan.md`](./github-integration-plan.md) · [`google-login-plan.md`](./google-login-plan.md)

---

## 3줄 요약

- 이 노트앱에 **Gmail·GitHub·OS 데이터를 끌어와** Claude가 읽고 처리하게 만들고 싶음.
- 다행히 **바닥 공사(events.db 창고 + 구글 로그인 + 깃헙 커넥터)는 이미 절반 넘게 완성**돼 있음.
- 정석은 새로 짓는 게 아니라 **깃헙 방식을 복사해 Gmail을 얹고**, "저장"과 "노트로 보여주기"를 분리하는 것.

---

## 1. 핵심 설계 원칙

### 1.1 저장 ≠ 보여주기 (가장 중요)

> 가져온 건 일단 **창고(events.db)에 원본 그대로** 넣고, 노트(.md)로 바꾸는 건 **필요할 때만** 따로 한다.

- 처음부터 md 파일로 다 박으면: 원본 손상/유실(재현 불가), 중복제거 키 소실, 증분 동기화 붕괴, 구조(읽음/라벨/스레드) 검색 불가.
- 이 원칙은 이미 코드/설계에 박혀 있음 (`raw-data-timeline-memory-plan.md` §2.2, §2.3).

### 1.2 narrow waist — 공통 엔벨로프

어떤 소스든 같은 포장으로 저장 (`events/mod.rs` `Entry`):

```
Entry { id, ts, ingested_at, source, kind, summary, entities[], refs[], payload }
```

- 겉은 고정(시각/출처/종류/요약), 속(payload)은 프로바이더 원본 통째로.
- 민감정보(인증토큰·내부ID)는 payload에 저장하지 않음.

### 1.3 커넥터는 코드 인터페이스가 아니라 관례

트레이트/추상 설계 없음. `SOURCE` const + `connector_state`(워터마크/etag) + `Entry` 업서트 세트가 곧 커넥터.
→ **Gmail 커넥터 = `github_sync`를 미러링한 함수 하나.**

### 1.4 Claude용 특별 포맷은 안 만든다

Claude Code는 **평범한 마크다운 + 깨끗한 frontmatter + 예측 가능한 폴더**를 제일 잘 읽음. 앱이 이미 그렇게 저장 중.
구조화 데이터는 md로 안 박고 events.db에 두고 **쿼리 도구**로 읽힘.

---

## 2. Claude에게 보여주는 2가지 길

- **(A) 그냥 물어보기** — "이번 주 메일 요약해줘" → events.db 쿼리로 답. **파일 안 만듦.** 가장 쉽고 빠름.
  - `events_fts`(FTS5 전문검색)와 `search_events`가 이미 있어 **노출만** 하면 됨.
- **(B) 노트로 저장** — "이 메일 노트로" 같은 명시적 액션에서만 `inbox/*.md` 물질화.
  - read-it-later 산문 캡처 경로(`saveArticleFromUrl`)와 사실상 동일 → 복제 재사용.
  - frontmatter에 `id`(예: `gmail:msg:...`)를 넣어 events.db로 역추적.

---

## 3. 정석 파이프라인

```
[1 연결]      [2 정규화]        [3 저장]       [4 물질화]         [5 소비]
OAuth      → provider JSON  → events.db   → .md 뷰(요청시)   → Claude Read/Grep
(Gmail/GH)   → Entry 엔벨로프   (사실 금고)    + daily 창문        + 쿼리 도구
```

- **1 연결**: Gmail = 기존 `google_oauth`에 `gmail.readonly` 스코프 추가. GitHub = 완료.
- **2 정규화**: provider 응답 → `Entry`. Gmail 예: `id=gmail:msg:<messageId>`, `kind=email`, `summary=제목 — 보낸사람`, `payload=원본(토큰·민감ID 제외)`.
- **3 저장**: `db::upsert_events`. 워터마크 = Gmail `historyId`(증분 동기화).
- **4 물질화**: (A) 쿼리 도구 기본 / (B) 명시적 액션에서만 md.
- **5 소비**: 내장 Read/Glob/Grep + CLAUDE.md 폴더지도, 또는 events 쿼리 도구.

---

## 4. 현황: 이미 있는 것 vs 새로 만들 것

| 부품 | 상태 | 위치 |
|---|---|---|
| 창고 (events.db) + 공통 엔벨로프 | ✅ 완성 | `events/mod.rs`, `events/db.rs` |
| 증분 동기화 (`connector_state` 워터마크) | ✅ 완성 | `events/db.rs:50` |
| 전문검색 (`events_fts`, `search_events`) | ✅ 완성 | `events/db.rs` |
| 깃헙 커넥터 (커밋·PR) | ✅ 완성 | `github.rs` |
| 구글 로그인 (자동 토큰갱신) | ✅ 있음 (스코프 = `openid email profile`만) | `google_oauth.rs` (`get_google_token:415`) |
| 산문 → inbox 노트 경로 | ✅ 완성 (defuddle 재사용) | `saveArticle.ts`, `articleService.ts` |
| **Gmail 스코프 켜기** | ❌ 해야 함 (열쇠) | `google_oauth.rs` |
| **Gmail 가져오는 코드 (`gmail.rs`)** | ❌ 해야 함 (깃헙 복붙 = 유일한 진짜 신규작업) | 신규 |
| events → 화면/노트 렌더 | ❌ 미개척 (공통 프론티어) | `githubColumnSpec.ts` 정의만, 소비자 없음 |

> 참고: `events/mod.rs:6-7` — "카드를 데일리 노트로 렌더링하는 건 later slice." events 적재는 완성, **렌더가 미개척**.

---

## 5. "스코프만 켜면 바로?" → 아니오, 2단계

- **1단계 — 스코프 켜기 (열쇠)**: `gmail.readonly` 추가 → 사용자 **재동의** 필요(무거운 동의 화면). 켜면 "메일 읽을 허가" 생김.
- **2단계 — 가져오는 코드 (배달부)**: 열쇠만으론 아무 일도 안 일어남. 깃헙처럼 "목록 불러와 → 창고에 넣어" 코드(`gmail.rs`)를 만들어야 함. 다행히 **깃헙 복붙**이라 작음.

---

## 6. OS Context (그다음 단계)

OS Context = 클라우드 API가 아니라 **맥이 이미 아는 로컬 데이터**(대부분 `~/Library/`). 같은 창고에 소스만 다르게 쌓음.

| 순위 | 소스 | 이유 / 주의 |
|---|---|---|
| 1 | **캘린더** | 이미 있는 구글 로그인, 타임라인 중심축 |
| 2 | **브라우저 방문기록** | 로컬 sqlite 읽기, "오늘 읽은 것" |
| 3 | **앱 사용시간 / 스크린타임** | 회고·요약에 강력 |
| — | 미리알림·연락처 | 보조 재료 |
| 후순위 | **iMessage** | 강력하지만 민감도 최상 + 전체 디스크 접근 권한 |
| 후순위 | **애플 건강(수면·걸음)** | 가치 높지만 아이폰에 있어 배관 공사 큼 |

**현실 주의 (메일·깃헙과 다른 점):**
- 맥 권한 관문(TCC): iMessage·전체파일은 "전체 디스크 접근 허용?" 프롬프트 필요.
- 프라이버시 무게: 훨씬 사적 → **전부 로컬 유지 + 명시적 동의**가 정석.

---

## 7. 액션아이템 (우선순위)

- [ ] **Gmail 스코프 추가** (`gmail.readonly`) — 사용자 재동의 흐름
- [ ] **`gmail.rs` 커넥터** — 깃헙 미러링, 메일이 창고에 쌓임 (`SOURCE="gmail"`, 워터마크=`historyId`)
- [ ] **events 쿼리 도구를 Claude에 노출** — "이번 주 메일 요약" 바로 (가장 빠른 체감, `events_fts` 재사용)
- [ ] (선택) **메일 → inbox 노트 저장** — 산문 캡처 경로 복제
- [ ] (이후) OS Context: 캘린더부터

---

## 8. 열린 결정 3가지 (내 추천)

1. **Claude 소비: 파일 물질화 vs 쿼리 도구?** → 기본은 쿼리 도구, 물질화는 명시적 액션에서만.
2. **Gmail 본문을 events.db에 넣나?** → 헤더·메타만. 긴 HTML 본문은 필요시 재fetch/물질화 시점에만 defuddle (비대화·민감정보 회피).
3. **동기화 트리거: 폴링 vs push?** → 깃헙처럼 주기 폴링 + 레이트리밋 조용한 백오프 (push watch는 서버 필요, 지금은 폴링이 정공법).
