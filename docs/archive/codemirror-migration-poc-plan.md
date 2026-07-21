# CodeMirror 전환 검토 — 측정 기반 PoC 계획

> 현재 에디터는 ProseMirror(Milkdown 7.20). "WYSIWYG는 부수적이고 AI 협업이
> 제품의 중심"이라는 전제 하에, 토대를 CodeMirror 6로 바꿨을 때 AI 협업 루프가
> 실제로 더 단순하고 덜 망가지는지를 **감이 아니라 숫자로** 판정하기 위한 PoC 설계.
> 전면 이주는 되돌리기 어려운 결정이므로, 작은 시제품 하나로 가설을 검증한 뒤
> 의사결정한다.

## 0. 결론을 내는 방식 (이 문서의 목적)

- "PM vs CM 어느 게 좋냐"는 추상 논쟁이 아니라, **하나의 측정 가능한 질문**으로
  환원한다: *AI 협업 루프의 앵커/위치매핑/구체화 층(현재 ~900 LOC)이 CM에서
  몇 줄로, 몇 개의 분기로 줄어드는가?*
- 이 문서는 그 측정을 위한 PoC의 범위·순서·지표·판정 규칙을 고정한다.
- 구체 실행은 이 계획을 기준으로 한 단계씩 별도로 진행한다.

## 1. 배경 — 두 모델의 근본 차이

| | ProseMirror (현재) | CodeMirror 6 |
|---|---|---|
| 문서 모델 | 구조화된 트리(node/mark) | 평문 텍스트(문자열) + 줄 |
| 메모리상 진실 | PM Document | string |
| 화면 | 완전 WYSIWYG | 원문 + 하이라이팅 (Obsidian식 Live Preview 가능) |
| 위치 표현 | resolved position (트리 경로) | 문자 offset (정수) |
| 강점 | 리치 편집·인라인 객체·구조 변환 | 텍스트/원문 편집·대용량·위치 안정성 |

AI 협업의 입출력 단위는 텍스트/diff다. CM의 문서 모델이 그것과 동일하다는 점이
"AI 중심이면 CM이 더 맞을 수 있다"는 가설의 근거다. 반대로 WYSIWYG·NodeView
리치함(카드·시각화 합성엔진)은 PM의 강점이며 CM에서는 약해진다.

## 2. 핵심 전제 — 비교의 솔기(seam)가 이미 깔끔하다

현재 AI 협업 루프는 세 층으로 분리돼 있다:

```
[1] AI/챗 → pendingChangesStore (단일 진실, 에디터 무관)   ← 재사용
[2] 에디터 층: 앵커 해석 + 렌더링 + 위치매핑 + commit       ← 교체 대상
[3] 디스크 적용: looseMatch / hunks (이미 "텍스트" 기반)    ← 재사용
```

결정적 사실 두 가지:

- `state/pendingChangesStore.ts`(411 LOC)는 PM을 전혀 모른다. `PendingEdit`은
  `{ kind: 'add'|'replace'|'delete', anchorBefore, before?, after? }` —
  **순수 마크다운 텍스트**다. 에디터를 바꿔도 이 층은 안 건드린다.
- 디스크 적용(`lib/looseMatch.ts`, `lib/computePendingHunks.ts`,
  `lib/intraEditDiff.ts`)은 **이미 `bodyMarkdown` 문자열 위에서 동작**한다.
  즉 시스템의 절반은 이미 CM이 사는 세계(텍스트)에 있다.

→ **PoC는 [2]번 층만 CM6로 다시 짜고, [1]·[3]은 그대로 붙인다.**
이것이 사과 대 사과(apples-to-apples) 비교를 가능하게 한다.

## 3. 측정 경계 (LOC 실측, 2026-06-05 기준)

| 층 | 파일 | LOC | PoC에서 |
|---|---|---|---|
| **교체 대상 ②** | `editor/anchorSearch.ts` | 172 | CM로 재구현 |
| | `editor/markReconcile.ts` | 343 | CM로 재구현 |
| | `editor/markStamp.ts` | 79 | CM로 재구현 |
| | `editor/inlineReviewPlugin.ts` | 885 | CM로 재구현 |
| | `editor/pendingTargets.ts` | 126 | CM로 재구현 |
| | **소계** | **1,605** | **비교 핵심** |
| 재사용 ①③ | `state/pendingChangesStore.ts` | 411 | 그대로 |
| | `lib/looseMatch + hunks + diff + strip` | 335 | 그대로 |
| | `lib/renderMarkdownInline.ts` | 245 | 그대로 (위젯 DOM) |
| 범위 외 | `editor/aiEditGutterPlugin.ts` | 323 | git-gutter, 별개 기능 |

## 4. 공정성 함정 — 반드시 (A)와 (B)를 분리한다

1,605 LOC를 통째로 "CM이 줄인다"고 하면 비교가 조작된다. 두 종류가 섞여 있다.

### (A) 앵커 / 위치매핑 / 구체화 로직 — CM이 줄이는 부분 (~900 LOC)
- `anchorSearch`(172): "렌더된 텍스트 ≠ 디스크 마크다운" 간극 때문에
  wikilink/블록마커 stripping을 3-tier로 수행. **CM에선 doc 텍스트 = 디스크
  마크다운이라 이 tier가 통째로 불필요** → `looseMatch` 한 번으로 수렴 예상.
- `markReconcile`(343): 블록 추가를 NodeView로 보여주려고 "실제 노드 삽입 +
  idempotent diff(present vs desired)"를 수행. **CM에선 추가분이 decoration/
  widget이라 reconcile diff 자체가 사라짐** → store로부터 선언적 재생성.
- `markStamp`(79) + `inlineReviewPlugin`의 resolve/apply/view 부분(~300):
  위치 매핑·재해석. **CM의 `ChangeSet.mapPos`가 내장 대체.**

### (B) 위젯 DOM 렌더링 — 양쪽 공통, 비교 제외 (~250 LOC)
- Reject/Keep 칩, after 미리보기, unplaced 배너 등. CM에서도 동일하게 필요.
- `renderMarkdownInline`(245)은 이미 에디터 무관이라 그대로 재사용.

> **진짜 가설:** (A) 약 900 LOC가 CM에서 몇 줄로 줄어드는가? 이 숫자 하나가
> 의사결정의 핵심이다.

## 5. 진행 순서 (5단계)

### Phase 0 — 기준선 계측 (대조군 먼저)
새 코드 작성 전에 현재 PM 구현을 숫자로 고정한다.
- (A)/(B) 분리해 LOC 확정.
- "깨질 구석" = 분기 수 계측: `anchorSearch`의 tier 폴백, `resolveAnchor`의
  4-상태(placed/hunks/unplaced/silent), reconcile의 list-merge 등 특수 케이스를
  세어 목록화.
- **앵커 안정성 테스트 하니스 작성 (가장 중요):** "push → 사용자가 N개 임의
  편집 → accept" 시 앵커가 올바른 범위에 남는지 검증하는 자동 테스트. PM에 먼저
  돌려 기준 통과율을 확보. 이 하니스는 양쪽 공통 자산이라 가장 먼저 만들 가치가 있다.

### Phase 1 — CM6 호스트 (문서모델 = 마크다운 증명)
같은 파일을 CM6로 로드. parser/serializer **없음** — doc 텍스트가 곧 디스크
내용. 여기서 이미 "serialize 왕복 버그 클래스 = 0"이 구조적으로 증명된다
(최근 커밋 `7786a1cc` idempotent serialize, skip no-op flush의 원인이 사라짐).

### Phase 2 — AI 루프 4동작을 CM로 이식
`pendingChangesStore`를 그대로 구독해서:
1. 앵커 표시 → `looseMatch`로 offset 찾고 `Decoration.mark`.
2. 사용자 편집 중 위치 유지 → `StateField` + `update.changes.mapPos`.
3. 수락/거절 → store의 `accept/reject` 그대로 + 디스크 적용 그대로.
4. 스트리밍 삽입 → `dispatch({ changes })` span 교체.

### Phase 3 — 동일 픽스처로 양쪽 측정
§7 시나리오 세트를 PM·CM 양쪽에 동일하게 돌려 §6 3숫자 수집.

### Phase 4 (선택) — Obsidian식 Live Preview 스파이크
WYSIWYG 손실의 질적 평가용. AI 루프 판단과는 분리. "WYSIWYG가 부수적"이라는
전제가 실제로 맞는지 눈으로 확인하는 용도.

## 6. 측정 지표 (정량 정의)

| 지표 | 정의 | 방법 |
|---|---|---|
| (A) LOC | 앵커/매핑/구체화 층 줄 수 | PM ~900 vs CM 실측 |
| 분기 수 | 폴백·특수케이스 개수 | tier/상태/엣지 카운트 |
| 앵커 안정성 | 임의 편집 후 정확 재부착 비율 | Phase 0 하니스 양쪽 실행 |
| 왕복 버그 클래스 | serialize round-trip 발생 지점 | PM: N개 / CM: 0 (구조적) |

## 7. 동일 테스트 픽스처 (양쪽 공통)

`resolveAnchor`의 모든 경로를 커버해야 공정하다.
1. add — 문서 끝 append / 앵커 뒤 삽입
2. replace — 단일행 / 다중행(블록 경계 횡단)
3. delete
4. whole-file replace → hunks 분해
5. **앵커 드리프트** — 결정 전 사용자가 위/안/아래를 편집 (핵심 스트레스)
6. 중복 앵커 — occurrence index 정확도
7. unplaced — 앵커 소실 시 배너

## 8. 의사결정 규칙

- (A) LOC가 명확히 축소(예: 900 → 250 이하) + 분기 수 감소 + 앵커 안정성 ≥ PM
  → **이주 정당.**
- 비슷하거나 더 복잡 → **PM 유지**, 통증은 PM 안에서 완화.

## 9. PoC가 일부러 증명하지 *않는* 것 (범위 한계)

- WYSIWYG 충실도, NodeView 리치함(카드·시각화 합성엔진) — Phase 4로 분리,
  명백한 손실 영역.
- 나머지 ~20개 PM 플러그인(슬래시·위키링크·페이스트 등) 이주 비용 — PoC 범위 밖,
  별도 산정.
- `aiEditGutterPlugin`(git 커밋 거터, 323 LOC) — 별개 기능.
- 문서 모델 교체는 **되돌리기 어려운 문**이라는 점.

## 10. 노력 추정 (러프)

| Phase | 산출물 | 추정 |
|---|---|---|
| 0 | 분기/LOC 계측 + 앵커 안정성 하니스 | 1일 |
| 1 | CM6 호스트, markdown=doc | 0.5일 |
| 2 | AI 루프 4동작 이식 (store/looseMatch 재사용) | 2~3일 |
| 3 | 동일 픽스처 양쪽 측정 | 0.5일 |
| **합계** | **감이 아닌 숫자** | **~4~5일** |
| 4 (선택) | Live Preview 스파이크 | +2~3일 |

## 11. 다음 단계

이 계획을 기준으로 한 단계씩 구체화하며 진행한다. 시작점 후보:
- **Phase 0의 앵커 안정성 테스트 하니스** — 대조군이자 양쪽 공통 자산이라
  최우선 가치.

---

## 12. 측정 결과 (2026-06-05 실측 완료)

코드: `apps/writer-tauri/src/editor/__poc__/`. 에디터 중립 하니스 + PM/CM
어댑터가 **동일 픽스처 10개**를 실제 코드로 통과시킨다. 전체 298 테스트 green,
typecheck/lint 깨끗. 측정은 체크인된 테스트(`measureStatics.test.ts`,
스냅샷)에서 재현된다.

### ① 앵커 안정성 (PRIMARY) — 동률 100%

| | 결정적 회귀 | 시드 랜덤(50회/픽스처) |
|---|---|---|
| PM (`anchorStability.pm.test.ts`) | 통과 | **50/50 전 픽스처** |
| CM (`anchorStability.cm.test.ts`) | 통과 | **50/50 전 픽스처** |

→ **CM은 PM의 안정성을 회귀 없이 동일하게 달성.** 무관 편집·드리프트·중복앵커·
unplaced→placed 승격까지 같은 시나리오를 통과. (CM 안정성의 출처는 직접 짠
코드가 아니라 CodeMirror 내장 `ChangeSet.mapPos` — 어댑터가 실제로 그것을 사용.)

### ② 코드량/복잡도 (HEADLINE) — CM이 ~5.5× 적음

"CM이 대체하는 PM 순수 앵커 로직" 4파일 vs CM 앵커층(`cmAnchor.ts`):

| | raw LOC | effective LOC | 분기(프록시) |
|---|---|---|---|
| PM (anchorSearch+markReconcile+markStamp+pendingTargets) | 724 | 427 | 197 |
| CM (`cmAnchor.ts`) | 130 | 78 | 62 |
| **감소** | **5.6×** | **5.5×** | **3.2×** |

감소의 출처(가설대로 입증됨): ①anchorSearch의 3-tier 정규화 → CM은 doc=마크다운
이라 `indexOf` 한 번. ②markReconcile/markStamp의 idempotent 노드 구체화 → CM은
decoration이라 통째로 불필요. ③수작업 위치매핑 → `ChangeSet.mapPos` 내장.

> **공정성 단서:** `inlineReviewPlugin.ts`(885줄)는 비교에서 제외했다. resolve/map
> 코어(CM은 ~StateField 30줄로 대체)와 위젯 DOM 렌더링이 섞여 있는데, 위젯 DOM은
> 양쪽 공통인 "(B) 층"이라 head-to-head에 넣으면 불공정하다. 즉 위 5.5×는 CM에
> **유리하게 과장하지 않은** 보수적 수치다.

### ③ serialize 왕복 버그 클래스 = 0 (구조적)

CM 어댑터는 parser/serializer를 **전혀 호출하지 않는다**(doc 자체가 마크다운).
최근 PM 커밋 3개(`7786a1cc` 등)를 낳은 왕복 경계가 CM엔 존재하지 않음 — 구조적으로 0.

### 결론 / 권고 업데이트

전제("WYSIWYG 부수적 + AI 협업 중심")가 사실이라면, **AI 협업 루프의 핵심 층에서
CM은 같은 신뢰성을 ~5.5× 적은 코드로 제공**한다는 가설이 숫자로 입증됐다.

단, 이 PoC가 증명하지 **않은** 것(§9): WYSIWYG 충실도, NodeView 리치함(카드·시각화
합성엔진), 나머지 ~20개 PM 플러그인 이주 비용, 위젯 DOM(B)층. 전면 이주 결정 전
**Phase 4(Obsidian식 Live Preview 스파이크)**로 "WYSIWYG가 정말 부수적인가"를
질적으로 확인하는 것이 다음 관문.

---

## 13. WYSIWYG 스파이크 결과 (2026-06-05 실측 완료)

코드: `apps/writer-tauri/src/prototypes/` (DEV 전용 라우트 `#/dev/cm-prototype`,
lazy+`import.meta.env.DEV` 가드라 프로덕션 번들 영향 0). CodeMirror 6 +
`@codemirror/lang-markdown`(@lezer/markdown GFM) 위에 자체 Live Preview 데코레이션
엔진(`livePreview.ts` StateField, `widgets.ts`)을 올려 실제 노트형 샘플을 렌더.

### 판정: **합격** — CM Live Preview가 우리 마크다운을 깔끔하게 렌더

브라우저(headless Chrome) 스크린샷으로 눈 확인. **Tier 1 + Tier 2 전부 동작:**

| 구분 | 항목 | 결과 |
|---|---|---|
| Tier 1 | 제목(h1~h3 크기별), 굵게/기울임, 인라인 코드 | ✓ PM과 동급 |
| | 글머리·번호 리스트, 인용구(좌측 보더+뮤트), 구분선, 링크 | ✓ |
| | **커서 줄에서만 기호 노출**(옵시디언식) | ✓ 동작(H1의 `#`은 커서가 그 줄이라 노출) |
| Tier 2 | 인라인 이미지(원격 URL + base64 data-URI) | ✓ 실제 `<img>` 렌더 |
| | 할 일 체크박스(GFM) | ✓ |
| | 위키링크 `[[제목]]`(브래킷 숨김+하이라이트) | ✓ 정규식 오버레이 |
| | GFM 표 | ✓ 진짜 `<table>`(헤더+보더) |
| | 펜스 코드블록 | ✓ 모노+뮤트 배경 |

검증: 헤드리스 엔진 단위테스트(`livePreview.test.ts`)가 데코 빌드 무결성(RangeSet
순서·노드명·커서노출 규칙)을 보장 + 전체 305 테스트 green + typecheck/lint 깨끗.

### 구현 중 확인된 사실 (이주 시 알아둘 것)
- **블록 데코는 StateField로만** 제공 가능(ViewPlugin 불가) — GFM 표(block replace)가
  이 제약에 걸렸고 StateField로 옮겨 해결. 표/이미지 같은 블록 위젯의 패턴.
- 타이포그래피는 기존 `--prose-*`/색 토큰을 `.cm-content`/줄 클래스로 재매핑만으로
  실제 에디터와 동급 룩 달성(테마 분리 용이).
- 데이터URI 이미지는 마크다운 문법상 URL에 공백/괄호 없어야 파싱됨(base64 권장).

### 결론 / 권고 (종합)
- AI 협업(§12): CM이 동률 신뢰성을 ~5.5× 적은 코드로. ✅
- WYSIWYG(§13): CM Live Preview가 우리 마크다운을 충분히 예쁘게 렌더. ✅
- → **"WYSIWYG는 부수적, AI 협업이 중심"이라는 전제 하에서 CM 이주는 두 핵심
  축에서 모두 청신호.**

### 여전히 미증명 (전면 이주 전 별도 검토)
- 카드(오디오/비디오)·**시각화 합성엔진**(Mermaid/VizNode) — CM 위젯 재구현 비용.
- 나머지 ~20개 PM 플러그인(슬래시·페이스트 새니타이저·위키링크 동기화 등) 이주.
- **편집 "손맛"**(타이핑 중 reveal 전환 플리커, IME, 표/이미지 줄 편집 시 raw 노출
  체감) — 정적 스크린샷이 아닌 실사용 손검증 필요.
- 표/블록위젯의 제자리 편집 UX(현재는 커서가 그 줄에 오면 raw 마크다운 노출).
