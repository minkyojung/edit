# Profile 생성/재생성 재설계 계획

> 작성일: 2026-05-31
> 상태: 설계 확정, 구현 전 (다음 브랜치에서 진행)
> 선행 작업: `56b760ef` — log/index 사이드바 숨김 + Profile/Conventions footer 행 이동
> 한 줄 요약: footer로 올린 Profile을 열면 빈 화면이 막다른 길이 되는 문제를, "상태를 보고 만들기/복구/재생성을 알아서 내주는 입력 표면 하나"로 해결한다.

---

## 1. 배경

직전 작업(`56b760ef`)에서 Profile을 사이드바 footer의 1급 행으로 올렸다. 그런데 **Profile을 눌렀을 때 비어 있으면 사용자가 할 수 있는 일이 없다** — 채울 방법이 first-run 온보딩 다이얼로그 하나뿐이고, 그건 1회성이라 재진입 경로가 없다.

이 빈 화면 문제를 풀면서, 프로필을 만드는 기능 자체(입력 방식, URL 견고성)도 함께 개선한다.

---

## 2. 현재 동작 진단 (사실 확인)

### 2.1 세 가지 진입 실패 케이스

| # | 상황 | 현재 동작 |
|---|---|---|
| 1 | 온보딩을 Skip하고 진입 | `OnboardingDialog`에 Skip 버튼 존재(`markBootstrapCompleted`) + input/done/failed 단계에선 Esc·바깥클릭으로 닫힘. → 빈 Profile만 남고 재진입 경로 없음 |
| 2 | 프로필 페이지가 (외부에서) 삭제됨 | 인앱 삭제는 사실상 불가(`canArchive:false` + footer 행에 컨텍스트 메뉴 없음). 외부 vault에서 `.md` 삭제 시 `ensureProfileWikiSlug`가 빈 페이지로 재생성 → 크래시 없음, 내용만 소실 |
| 3 | 그냥 다시 만들고 싶음 | 트리거할 UI가 first-run 밖에 없음 (함수는 존재, §2.3) |

> 케이스 1의 "온보딩을 강제 게이트로" 안은 **채택하지 않는다.** 파이프라인은 외부 fetch 의존이라 실패 가능 → 강제하면 fetch 실패 시 사용자가 제품에 진입조차 못 함. CLAUDE.md "외부가 죽어도 앱은 멀쩡" 원칙 위반. 강제 벽 대신 "언제든 채울 수 있는 empty-state"가 정답.

### 2.2 복구 자산 — sources는 페이지와 별도로 저장됨

파이프라인이 fetch한 원본 글은 `saveSources`로 **vault에 따로 persist**된다 (`profile/sources.ts`). 따라서:

- 프로필 페이지가 지워져도 **재fetch·URL 재입력 없이** 저장된 sources로 재생성 가능 (케이스 2 복구).
- 재생성 시 `loadOrFetchSources`가 캐시된 sources를 먼저 사용 → 매번 다시 긁지 않음.

### 2.3 인프라는 이미 존재 — 빠진 건 UI 진입점

| 기능 | 함수 | 위치 | 상태 |
|---|---|---|---|
| URL → 분석 → 페이지 전체 생성 | `runProfilePipeline` | `profile/pipeline.ts:70` | ✅ |
| 캐시된 sources 우선 사용 | `loadOrFetchSources` | `profile/pipeline.ts:147` | ✅ |
| 존 단위 안전 재생성 | `runSection` | `profile/pipeline.ts:112` | ✅ (Background/Notes 보존) |
| sources 존재 확인 | `hasAnySources` / `readAllSources` | `profile/sources.ts` | ✅ |
| 빈 페이지 lazy 생성 | `ensureProfileWikiSlug` | `state/wikiService.ts:218` | ✅ |
| URL 어댑터 사다리 | `discoverAndFetch` | `profile/adapters/index.ts` | ✅ (3단계) |
| 입력의 공통 형태 | `Document` 타입 | `profile/adapters/index.ts` | ✅ |

→ 새로 만들 것: **빈 화면 감지 + empty-state UI + 통합 입력칸 + 파일 어댑터 + URL 폴백 어댑터**, 그리고 `OnboardingDialog`를 first-run 밖에서도 부를 수 있게 **재사용 다이얼로그로 분리**.

### 2.4 발견된 버그 — 전체 재생성이 사용자 편집을 파괴

`runProfilePipeline` → `writeWikiProfile`는 `replaceDocBody(slug, markdown)`로 **본문을 통째로 교체**한다. 그런데 `assembleMarkdownFromSections`는 Voice/Themes/About/Sources만 조립하고 **Background(ingest 관리)·Notes(사용자 소유)는 포함하지 않는다.**

→ **전체 재생성 시 사용자가 적은 Background/Notes가 통째로 사라진다.** 진입점을 만들기 전에 비파괴화 필요 (§4.4).

---

## 3. 핵심 통찰 — 세 케이스는 하나의 상태기계로 수렴

따로 만들 필요 없다. 판단 기준은 두 가지뿐:
- 페이지에 **내용이 있나?**
- vault에 **저장된 sources가 있나?** (`hasAnySources`)

```
빈 페이지 + 소스 없음   → "URL/파일 주고 프로필 만들기"      (케이스 1 skip, 케이스 2 완전 삭제)
빈 페이지 + 소스 있음   → "저장된 글로 다시 생성"(원클릭) + 새 소스   (케이스 2 소프트 복구)
채워진 페이지          → 섹션별 재생성 + 전체 재생성 + 새 소스    (케이스 3)
```

진입점 두 곳:
- **빈 Profile의 empty-state** — 위 두 줄 담당.
- **채워진 Profile 안의 액션** — 아래 줄 담당 (섹션 옆 "다시 생성" + 페이지 메뉴 "전체 재생성/새 소스로").

---

## 4. 작업 항목

### 4.1 빈 Profile empty-state + 통합 입력 (가장 큰 효과)

**무엇**: 빈 Profile 페이지 본문 자리에 안내 + 입력칸을 띄운다. `hasAnySources()` 결과로 분기:
- 소스 없음 → "글의 주소나 파일을 주면 프로필을 자동 생성" + 통합 입력.
- 소스 있음 → "저장된 글로 다시 생성"(원클릭) + "다른 소스로" 옵션.

**통합 입력 = 칸 하나로 URL·파일·텍스트 자동 판별** (§5.2 선례):
- URL 정규식 매치 → URL 경로.
- File 드롭/선택(확장자·MIME) → 파일 경로.
- 그 외 → 생text 경로.

**재사용**: `OnboardingDialog`의 알맹이(입력 → `runProfilePipeline` → 진행 표시)를 별도 컴포넌트로 분리해 first-run과 Profile 페이지 양쪽에서 호출.

### 4.2 파일 import 어댑터

**무엇**: `.md`(우선) 파일을 읽어 `Document[]`로 변환하는 어댑터. 파이프라인·LLM·페이지 생성은 그대로.

- `Document` 계약(`sourceUrl`/`title`/`contentMarkdown`)에 맞춰 매핑. 파일은 `sourceUrl` 대신 파일명/경로.
- YAML frontmatter가 있으면 보존/활용 (선례 §5.4: frontmatter가 표준 메타데이터 계약).
- 폴더/다중 파일은 후순위 — 1차는 단일~소수 파일.

### 4.3 URL 견고성 — 폴백 사다리에 Jina Reader 추가

**문제**: 현재 `discoverAndFetch`는 RSS→Sitemap→Readability 3단계뿐. `fetch_url`이 raw HTML만 받아 **JS 렌더링 페이지·PDF·소셜 프로필은 빈 결과**.

**무엇**: 사다리 **맨 끝에 어댑터 하나 추가** — 앞 3개가 모두 비면 Jina Reader(`r.jina.ai/<url>`)로 폴백.
- Jina: 서버에서 JS 렌더링 → 마크다운 반환, API 키 없이 20 RPM, PDF 지원.
- 대안 Firecrawl은 동급이나 키·과금 필요 → 무료 진입은 Jina 우위.

**신뢰성 가드 (CLAUDE.md 원칙)**:
- 외부 서비스라 느리고(평균 ~8초) 죽을 수 있음 → **폴백으로만**, 실패 시 조용히 빈 결과 → empty-state 복귀. 앱은 멈추지 않음.
- 소셜(X/LinkedIn) 등은 로그인 벽으로 OG 메타데이터(이름/소개)만 나올 수 있음 → UI에서 기대치 솔직히 표시.

### 4.4 전체 재생성 비파괴화 (버그 수정, 안전상 필수)

**무엇**: `runProfilePipeline`의 쓰기 경로가 Background/Notes를 보존하도록 수정.
- `runSection`이 이미 쓰는 `replaceZone` 방식 확장 — 관리 존(Voice/Themes/About/Sources)만 교체하고 Background/Notes는 기존 본문에서 유지.
- 기존 페이지가 있으면 현재 본문을 읽어 존별 splice, 없으면(첫 생성) 전체 조립.

---

## 5. 선례 분석 (요약)

> 상세 근거는 2026-05-31 리서치. 아래는 우리 결정에 직접 쓰인 패턴만.

### 5.1 "어떤 URL이든" = 단일 추출기가 아니라 폴백 사다리

모든 제품이 싸고 빠른 것부터 시도 → 빈 결과면 무거운 것으로 escalate.
- 1단계 인프로세스 파서: **Mozilla Readability / Postlight(Mercury)** — JS 못 읽음.
- 2단계 LLM지향 URL→마크다운: **Jina Reader / Firecrawl** — 서버 JS 렌더링, 마크다운 반환. 업계의 사실상 견고 폴백.
- 3단계 헤드리스 브라우저: ScrapingBee/Apify/Browserless — 보통 안 감.
- 보조: **OpenGraph/oEmbed** — 본문이 막힌 소셜 URL의 메타데이터.
- 반복 패턴: 출력은 **마크다운으로 통일**하는 게 LLM 입력 표준 계약.

### 5.2 입력 UX = "소스 추가" 진입점 하나로 합치고 자동 판별

- **Gamma**: Generate/Paste/**Import** — Import 안에 파일+URL 공존.
- **Perplexity Spaces**: 파일 업로드 + "Add Links" URL 필드 공존.
- **ChatGPT/Claude Projects**: 페이퍼클립/드롭존 하나에 PDF·DOCX·MD·TXT 등.
- 판별: **입력 모양** — URL 정규식 → fetch, File MIME/확장자 → 파싱, 나머지 → 생text.
- 반복 패턴: 모달리티별로 화면을 쪼개지 않고 **하나의 액션 뒤에** 둔다. URL은 발견성 위해 명시적 "링크 붙여넣기"도 함께 노출.

### 5.3 AI 프로필 생성 = 우리는 "코퍼스→합성" 진영

| 진영 | 입력 | 예시 |
|---|---|---|
| 식별자→보강 | 이메일/도메인/핸들 | Clearbit, Apollo, Clay |
| **코퍼스→합성** | 본인이 쓴 글/영상 뭉치 | **Delphi.ai, Personal AI ← 우리** |

- 공통 원칙: **AI는 초안 제안, 사람이 섹션 단위로 수정** (편집 가능 draft). LinkedIn 인라인 제안, Delphi "응답 다듬기", Clay AI 컬럼 모두 동일. → 우리의 Voice/Themes/About 편집 가능 구조 + `runSection` 존 재생성이 이미 정석.
- Clay "waterfall enrichment"(소스 폴백으로 커버리지 65%→90%) = §4.3 URL 사다리와 같은 사상.

### 5.4 마크다운 import = 폴더/ZIP는 대량, 단일은 일회성 + frontmatter 보존

- Obsidian/Logseq: "마크다운 폴더 가리키면 끝" (vault 자체가 마크다운).
- **YAML frontmatter가 보존 대상 표준 계약**. 관계형 파생 메타(Notion relations/rollups)는 보통 import 시 유실 → 우리도 frontmatter만 보존 약속.

---

## 6. 만드는 순서 + 검증 기준

```
1. empty-state + 통합 입력 + 재사용 다이얼로그 분리  (§4.1)   ← 케이스 1·2 해결, 효과 최대
2. 전체 재생성 비파괴화                              (§4.4)   ← 작지만 안전상 필수, 진입점보다 먼저
3. URL 폴백 어댑터 (Jina)                            (§4.3)   ← 견고성 보강
4. 파일 import 어댑터                                (§4.2)   ← 입력 모달리티 확장
```

> 2번을 1번 직후에 두는 이유: empty-state가 생기면 "다시 만들기"가 노출되는데, 그게 사용자 편집을 지우는 상태로 노출되면 안 됨.

| 단계 | verify |
|---|---|
| 1 | 빈 Profile 열기 → URL 입력 → 섹션 생성됨 → 다시 열면 내용 유지. 소스 있을 땐 원클릭 재생성 노출 |
| 2 | Background/Notes에 글 적고 전체 재생성 → 그 글이 그대로 남아 있음 |
| 3 | JS 렌더링 블로그/PDF URL 입력 → 앞 3어댑터 빈 결과 후 Jina로 내용 추출. Jina 죽여도 앱 멀쩡, 빈 결과 → empty-state |
| 4 | 로컬 `.md` 파일 떨구기 → Document로 변환 → 프로필 생성. frontmatter 보존 |

---

## 7. 트레이드오프 / 미결정

- **(확정) 온보딩 강제 게이트 안 함** — 외부 의존 실패 시 진입 차단 위험. empty-state가 재진입점.
- **(확정) 전체 재생성은 비파괴** — Background/Notes 보존 (경고 띄우는 안 대신).
- **(확정) URL 폴백은 Jina 우선** — 무료·키 불필요. Firecrawl은 후보로만.
- **(미결정) 파일 import 범위** — 1차 단일 `.md`만 vs 폴더/PDF/DOCX까지. 1차는 `.md` 단일~소수로 좁히고, PDF는 Jina가 URL 경로로 이미 커버하므로 후순위.
- **(미결정) 생text 붙여넣기 경로** — 통합 입력의 세 번째 갈래. 1차 포함 vs 후속. 구현 비용 작아 1차 포함 권장.
- **(미결정) 소셜 URL 처리** — OG 메타데이터만이라도 받을지, 아예 "지원 안 함" 안내할지. 1차는 후자(명확한 한계 표시)가 단순.

---

## 8. 코드 지도 (건드릴 곳)

**기존 (수정/재사용)**
```
profile/pipeline.ts          runProfilePipeline 비파괴화(§4.4), runSection 재사용
profile/adapters/index.ts    discoverAndFetch 사다리 끝에 Jina 어댑터 추가(§4.3)
profile/sources.ts           hasAnySources로 empty-state 분기(§4.1)
profile/ui/OnboardingDialog.tsx  알맹이를 재사용 다이얼로그로 분리(§4.1)
state/wikiService.ts         ensureProfileWikiSlug / readSelfProfile (그대로 사용)
```

**신규**
```
profile/adapters/jina.ts          URL 폴백 어댑터(§4.3)
profile/adapters/file.ts          .md → Document 파일 어댑터(§4.2)
profile/ui/ProfileSetupDialog.tsx  OnboardingDialog에서 추출한 재사용 다이얼로그(§4.1)
profile/ui/ProfileEmptyState.tsx   빈 Profile 본문 안내 + 통합 입력(§4.1)
editor 진입점                      빈 wiki:profile 감지 → empty-state 렌더 (위치 확인 필요)
```

> ⚠️ 빈 Profile을 "어디서 감지해 empty-state를 렌더할지"는 위키 페이지 렌더 진입점 확인 후 확정 (에디터가 빈 본문일 때 오버레이 vs 페이지 컴포넌트 분기).
