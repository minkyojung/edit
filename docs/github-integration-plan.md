# GitHub 연동 기능 개발 계획

> 작성일: 2026-05-31 · 진행 현황 업데이트: 2026-06-04 (코드 감사 반영)
> 상태: **Phase 1(인증) ✅ + Track A(데이터 커넥터) ✅ 마감(증분 ✅ + rate-limit ✅; ETag는 search API 미지원 확인→스킵) — Track B(vault 백업) 🟡 새 repo push ✅ + 수동 백업 허브 ✅ + 복원/받기(clone·pull·첫실행 런처) ✅ 코드완료·실측대기, 충돌만 남음**
> 한 줄 요약: "GitHub"은 두 갈래(활동 가져오기 / 노트 백업) — 공통 토대인 인증을 먼저 만들고, 수직 슬라이스로 한 갈래씩.

---

## 진행 현황 (2026-06-04)

`data-structure-github-sync` 브랜치 기준 실제 구현 상태. (✅ 완료 / 🟡 부분 / ❌ 없음)

| 항목 | Phase | 상태 | 위치 |
|---|---|---|---|
| OAuth Device Flow 로그인 | 1 | ✅ | `src-tauri/src/github.rs` (start/poll_github_device_flow) |
| 토큰 키체인 보관 (AES-256-GCM) | 1 | ✅ | `secure_storage.rs`, `github.rs` (StoredToken) |
| 인증 상태 hook (useClaudeAuth 미러) | 1 | ✅ | `src/hooks/useGitHubAuth.ts` |
| 공용 GitHub 클라이언트 래퍼 | 1 | ✅ | `github.rs` (github_get) — 한도 소진(403/429+remaining 0) 감지→`GithubError::RateLimited`, github_sync는 조용히 스킵+다음 폴링 재시도. github.rs 내부 전용 |
| events.db 스키마 (events+state+FTS) | 2 | ✅ | `src-tauri/src/events/db.rs` (init_schema) |
| GitHub 커넥터 폴링 (커밋·PR) | 2 | 🟡 | `github.rs` (github_sync) — `/users/me/events` 대신 search API 사용 |
| events.db UPSERT (id 중복제거) | 2 | ✅ | `github.rs`, `events/db.rs` (upsert_events) |
| 데일리 노트 활동 카드 렌더 | 2 | ✅ | `src/viz/GitHubActivityBlock.tsx` (CodeBlockViz 변형) |
| 증분 동기화 (watermark) | 2 | ✅ | `github.rs` (since_date/next_watermark) — 날짜 범위로 새 것만, 레거시 자가치유. 실측 109→10건 |
| 증분 동기화 (ETag 304) | 2 | ⛔ N/A | **스파이크 실측 결과 search API 미지원**(`search/commits`·`search/issues` → ETag 헤더 없음 + `cache-control: no-cache`; 대조군 `/users`는 둘 다 있음). 커넥터는 search 사용(events payload slim) → ETag 불가. 스킵 확정 |
| 원격 git 명령 (remote_set/push/clone/fetch/pull_ff) | 3 | ✅ | `git.rs` — credential-helper. pull_ff=fast-forward만(갈라지면 중단, 마커 안 씀). 충돌 merge는 R4 |
| repo 관리 API (생성·목록) | 3 | 🟡 | `github.rs` (create_repo, list_repos/github_list_repos). 내vault 판별은 clone 후 manifest로 |
| syncStore + `.manila/manifest.json` 표식 | 3 | ✅ | `vault_sync.rs` (manifest+vaultId), `src/state/syncStore.ts` |
| 백업 엔진 — 슬라이스 1 (새 repo push 1회) | 3 | ✅ | `vault_sync.rs` (vault_backup_init) |
| 백업 엔진 — 슬라이스 2 (수동 백업 허브) | 3 | ✅ | 자동 push는 만들었다가 **수동으로 전환**(커밋 `e1d9e1a8`). 검토 패널이 "마지막 푸시(`@{u}`) 이후 변경"을 보여주고 **Back up** 버튼으로 push. `vault_push`/`pushVault`, AI 배지. autoPush.ts는 삭제. |
| 백업 엔진 — 슬라이스 3 (다른 기기 clone/pull 복원) | 3 | ✅ 코드완료·실측대기 | `vault_restore`(빈 폴더 clone + manifest 확인, 안 덮어씀) + `vault_pull`(앱 열 때 ff 받기) + `VaultLauncher`(첫 실행 런처: 로컬/복원, 인라인 GitHub 연결) + BootGate boot-pull. `lib/vaultRestore.ts` |
| 충돌 데이터 계층 (ours/theirs, conflict_sides) | 3 | ❌ | 없음 |

**계획에 없던 추가 구현:** 활동 컬럼 차트(`githubColumnSpec.ts`/`githubDailySpec.ts`, **자체 SVG 엔진 DataViz** — Vega-Lite는 제거됨), 이벤트 FTS 검색(`events/db.rs`+`events/commands.rs`), 이벤트 필터(`EventFilter`), 수동 동기화 버튼(사이드바). + 시각화 합성 엔진 통일 편집(커밋 `6835d57c`, [visualization-feature-plan.md](./visualization-feature-plan.md) 참고).

---

## 0. 이 문서의 범위

GitHub과 관련된 두 기능을 한 문서에서 다룬다. 둘은 **방향·데이터·목적이 완전히 다른 별개 기능**이지만 **인증 한 층만 공유**한다.

| | **A. 데이터 커넥터** | **B. vault 백업/동기화** |
|---|---|---|
| 무엇 | GitHub에서 내 **활동(커밋·PR)을 읽어와** 타임라인/메모리에 쌓음 | 내 **노트(vault)를 repo에 올려** 백업 + 다른 기기 복원 |
| 방향 | GitHub → 앱 (읽기) | 앱 ↔ GitHub (쓰기/복원) |
| GitHub 역할 | 데이터 소스 | 노트 저장 창고 |
| 저장 | `events.db` (SQLite) | git repo (markdown 파일) |
| 상태 | 스펙 완비 ([raw-data-timeline-memory-plan.md](./raw-data-timeline-memory-plan.md) §9–10) | 본 문서에서 설계 |

> **핵심: 하나를 만들어도 다른 쪽 부품은 안 생긴다.** 유일한 공통은 §2 GitHub 인증. 둘 다 그 위에 얹힌다.

---

## 1. 선행 조건 (Phase 0) — 기능 얹기 전 반드시

**지금 브랜치를 main에 착지시키거나 고정 기준선으로 동결한다.**

- 현재 브랜치는 main 대비 ~98커밋 미머지 (검증 안 된 토대).
- 이번 세션 작업(commit-gap 수정·새 페이지 생성·멀티라인 배치 등)도 feature 브랜치에만 있음.
- 검증 안 된 토대 위에 동기화/커넥터 같은 큰 기능을 또 얹으면 버그 추적이 지옥. (raw-data 계획 §6, §7의 "페인트부터 말리기")

→ **GitHub 기능은 토대가 굳은 뒤 새 브랜치에서 시작.**

---

## 2. 공통 토대 (Phase 1) — GitHub 인증 ✅ (스코프 `repo`로 확장, 클라이언트 래퍼만 🟡)

A·B 둘 다 GitHub 토큰이 필요하다. **한 번 만들어 공유한다.**

### 구현 범위
- **GitHub OAuth 로그인** — 제품 방향이 "GitHub 로그인 강제"이므로 PAT(개발자용)이 아니라 OAuth가 맞다. `repo` 권한 요청.
  - (참고: raw-data §9.2는 커넥터 첫 슬라이스용으로 PAT를 제안했음. 제품이 로그인 강제로 가면 OAuth로 통일.)
- **토큰 보관 = OS 키체인** (Tauri secure storage). localStorage·repo URL·payload·events.db 어디에도 평문 저장 금지.
- **인증 상태 store** — 기존 `useClaudeAuth` 패턴 미러 (연결됨/끊김/만료 상태).
- **GitHub 클라이언트 한 겹** — 인증 + rate-limit + 에러 처리를 감싼 공용 호출 래퍼. A의 REST 호출과 B의 repo 관리 API가 같이 씀.

### 신뢰성 (wellmade 원칙)
- 토큰 만료 → "다시 연결" 상태 명확 표시. 조용한 실패 금지.
- 토큰은 웹뷰 밖(Rust)에 두는 걸 우선 검토 — API 호출도 가능하면 Rust(reqwest)에서.

### verify
- 로그인 → 토큰이 키체인에 저장됨 → 앱 재시작해도 연결 유지 → 끊기 누르면 토큰 삭제.

---

## 3. Track A — 데이터 커넥터 (인증 다음 1순위) 🟡 동작 (증분 동기화 ✅, ETag만 남음)

상세 스펙은 [raw-data-timeline-memory-plan.md](./raw-data-timeline-memory-plan.md) §9–10에 이미 있음. 여기선 순서만.

### 만드는 순서 (수직 슬라이스 — 프레임워크 먼저 X)
1. `events.db` 스키마 (§10.1) — events 테이블 + connector_state + fts. Rust(rusqlite/sqlx), vault 폴더 안.
2. GitHub 커넥터 1개 — `GET /users/me/events` 폴링 → commit + PR만 추림 (§9.7).
3. 공통 포장지로 map → events.db UPSERT (id로 중복제거, §9.4).
4. 데일리 노트에 이벤트 카드 렌더 (기존 card NodeView 재사용, §10.3).
5. **verify**: 오늘 내 커밋이 데일리 타임라인에 뜬다 + **GitHub 꺼도 앱 멀쩡**.

### 방식 원칙
- 외부(GitHub) 죽어도 커넥터만 조용히 실패, 앱은 멀쩡 + 다음 폴링 재시도 (§9.4).
- 증분 동기화: watermark + ETag (변화 없으면 304, rate limit 0).
- 데스크탑은 webhook 불가 → 앱 켤 때 + 주기(30분~1h) 폴링 (§9.5).

---

## 4. Track B — vault 백업/동기화 (A 다음, 또는 멀티기기 필요해질 때) 🟡 뼈대 완료 (1번 슬라이스: 새 repo push)

> 상태: 문서상 future 항목 (`mvp-scope.md` "자동 git 백업"/"Multi-device sync"). 동기화 수단도 재검토 대상(GitHub repo vs iCloud/libsql — raw-data §143). **GitHub repo로 간다고 가정한 설계.**

### 핵심 구조 (엔진은 git 정공법, UI는 추려서 래핑)
버전관리를 직접 만들지 않는다. **엔진 = 실제 git** (이미 있는 `git.rs`에 원격 명령만 추가). UI는 git 출력을 1:1로 까지 말고 "페이지·평이한 말"로 번역. (git의 staging/branch/ref/SHA는 절대 노출 X)

### 비어 있는 한 층 = "원격" (현재 `git.rs`는 전부 로컬, 원격 연산 0개)
아래에서 위로:
1. **원격 git 명령** — `git.rs`에 `remote_set / push / fetch / clone / merge` + 충돌용 `conflict_sides(path)` 추가. 토큰을 자격증명으로 주입(디스크 미저장).
2. **repo 관리 API** — repo 목록 / 새 repo 생성 / repo 비었나·내 vault인가 검사 (Rust + §2 클라이언트).
3. **바인딩 + 신원 표식** — 새 `syncStore`(영속): `{ repoFullName, remoteUrl, branch, lastSyncedSha, vaultId, status }` + repo 안에 `.manila/manifest.json`(= `vaultId`) 표식 파일. → "이게 내 vault인가"를 추측 아닌 **결정적**으로 판별 (린치핀).
4. **동기화 엔진 (단일 소유)** — push/pull 호출을 흩지 말고 한 모듈이 소유 (지금 `pendingChangesApplier`가 commit을 한곳에 모은 패턴). 책임: 커밋 나면 push / 앱 열면 pull+merge / 오프라인 재시도 큐 / connect 플로우 / merge 후 충돌 감지.
5. **충돌 데이터 계층** — merge 충돌 시 파일에 `<<<<<<<` 안 박고, 양쪽 버전(ours/theirs)을 데이터로 꺼냄. 감지는 git, 표현은 우리.

### connect 플로우 (로컬 × 원격 화해)
연결 시 "새 repo / 기존 repo"만 묻고, 앱이 표식을 검사해 결정:

| | 원격: 빈/새 | 원격: **내 vault**(표식 일치) | 원격: 무관한 내용 |
|---|---|---|---|
| 로컬 비어있음 | 연결 | **clone**(복원/2번째 기기) | ⚠️ 막기 |
| 로컬 내용 있음 | **push up**(첫 백업) | ⚠️ **양쪽 데이터 → 명시 선택** | ⚠️ 막기(새 repo 권장) |

- 어느 쪽도 **조용히 덮어쓰지 않는다.** 파괴적 동작은 항상 명시 확인.
- 둘 다 내용 있을 때: 자동 머지 금지 → "로컬 우선 / 원격 우선 / 둘 다" 택1.

### 만드는 순서 (수직 슬라이스, 가장 흔하고 안전한 것부터)
1. ✅ **걸어다니는 뼈대**: 로그인 → 새 repo 자동 생성 → 노트 1회 push → GitHub에서 눈으로 확인. (완료 — `vault_sync.rs` vault_backup_init, 토큰은 credential-helper로 ps/디스크 미노출, 실측 검증)
2. ✅ **수동 백업 허브**: 자동 push로 시작했다가 **수동으로 전환**(커밋 `e1d9e1a8`). 검토 패널이 "마지막 푸시(`@{u}`) 이후 변경"을 목록으로 보여주고 **Back up** 버튼이 `vault_push`로 올림 → 목록 비워짐. 기준점이 git-native ref(`@{u}`)라 예전 last-reviewed 책갈피 버그류 소멸. 커밋은 그대로 자동(로컬 보존)이라 데이터 안전. (자동 push 트리거는 제거, push 배관은 재사용.)
3. ✅ **다른 기기** (코드완료·실측대기): 첫 실행 런처(`VaultLauncher`)에서 GitHub 연결(인라인 device flow) → 내 repo 목록 → 빈 폴더 선택 → `vault_restore` clone. 앱 열 때 `vault_pull`(ff)로 받기. **복원은 git init 전에 가로채야 가능**(빈 폴더에서만)이라 런처가 부팅 앞단에 위치.
4. ❌ **충돌**: 두 기기서 같은 페이지 동시 수정 처리. (방향 확정: 별도 UI 없이 git 자동머지 + "둘 다 보관" + 충돌 정보를 AI 세션에 노출해 채팅에서 해결.)

### 충돌 UX 원칙 (디자이너 관점)
- 단위는 "파일"이 아니라 **"겹친 페이지"** (페이지 이름으로).
- 평이한 말 ("두 기기서 같은 페이지를 동시에 고쳤어요"). HEAD/merge/SHA 금지.
- **절대 안 잃음** — 처음 버전은 "둘 다 보관"(conflicted copy)부터. 인라인 해결 토글은 다음.
- 조용한 배지로 알리고 모달로 막지 않음. diff는 "자세히 보기" 상세 레이어로만.

---

## 5. 모든 단계 공통 — 정석 방식

- **수직 슬라이스 먼저, 프레임워크 먼저 X.** 가장 단순한 경로 하나를 끝까지 관통한 뒤 살을 붙임.
- **스위치(feature flag) 뒤에서.** 새 기능이 꺼져도 기존 유저가 안 깨지게.
- **매 단계 실데이터로 verify.** "될 거다" 아니라 진짜 되는지 눈으로.
- **외부 죽어도 앱 멀쩡.** 외부 의존은 본질적으로 불안정 → 조용한 실패 + 재시도, 크래시 X.
- **아무것도 안 잃음.** 어느 단계도 노트를 덮어쓰거나 지우지 않음.

---

## 6. 전체 순서 요약

```
Phase 0  지금 브랜치 main 착지/동결           ← 페인트 말리기 (선행 필수)
Phase 1  GitHub 인증 (OAuth repo 스코프 + 키체인 + 클라이언트)  ✅
Phase 2  Track A: 데이터 커넥터 (events.db 수직 슬라이스)  ✅ 마감 (증분 ✅ + rate-limit ✅, ETag N/A)
Phase 3  Track B: vault 백업/동기화                      🟡 슬라이스 3까지(코드)
          1 새 repo push (뼈대) ✅ → 2 수동 백업 허브 ✅ → 3 다른 기기 복원 ✅(실측대기) → 4 충돌 ❌
```

---

## 8. 다음 할 일 (우선순위)

1. ~~ETag 304~~ ⛔ **N/A 확정** — 실측 결과 search API 미지원(ETag 없음·`no-cache`). 스킵.
2. ~~rate-limit 처리~~ ✅ **완료**(커밋 `6114050a`) — 한도 소진 감지→우아한 스킵. → **Track A 마감.**
3. ~~슬라이스 3 복원~~ ✅ 코드완료 — **실측 필요**: 빈 폴더에서 새 기기처럼 로그인→복원 picker→clone→원본 일치 확인. 그리고 .DS_Store만 있는 폴더 엣지(클론 거부) 확인.
4. **Track B 슬라이스 4 — 충돌** — `conflict_sides(path)`(git 감지, ours/theirs 데이터로) + "둘 다 보관" + **충돌 정보를 AI 세션 컨텍스트로 노출**(차트 통일 편집 레일 재사용) → 채팅에서 해결. 전용 UI 없음. 멀티기기 본격 사용 시.

> 결정 대기(§7): 동기화 수단(GitHub repo vs iCloud/libsql)은 슬라이스 3 착수 전 재확인.

---

## 7. 결정 필요 / 미결정

- **인증 방식**: OAuth(제품 로그인 강제용, 권장) vs PAT(커넥터 첫 슬라이스 빠른 길). → OAuth로 통일 가정.
- **A 먼저 vs B 먼저**: 문서 본 줄기는 A. B는 멀티기기 필요가 실제로 생길 때. → A 우선 가정.
- **동기화 수단(B)**: GitHub repo vs iCloud/libsql/sync 서버 (raw-data §143은 후자 선호). → 본 문서는 GitHub repo 가정이나, B 착수 전 재확인.
- **토큰·API 위치**: 웹뷰(TS) vs Rust. 보안상 Rust 우선 검토.
