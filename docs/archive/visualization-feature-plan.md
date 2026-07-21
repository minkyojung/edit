# 시각화 기능 설계 문서 (Mermaid / Vega-Lite)

> 목표: 챗 에이전트가 만든 다이어그램·차트를 **대화 안에서 인라인으로 보여주고**, 필요하면
> **본문(에디터)에 삽입**한다. 디자인은 앱의 디자인 토큰을 따른다.
> Claude Desktop의 "Visualizer"와 같은 사용자 경험을, 우리 스택(Tauri + Milkdown)에 맞게
> **직접(clean-room) 구현**한다.

---

## 진행 현황 (2026-06-04, 코드 감사 반영)

> **이 섹션이 현재 진실.** 아래 §0~§7은 *원래* 계획(2026-05 초안)이며, 실제 구현은 크게 분기했다 — 특히 **Vega-Lite는 폐기**(자체 SVG 엔진으로 대체)되고, **아티팩트(임의 HTML)**·**선언형 차트 엔진**·**VizNode 합성**·**채팅 에이전트 통일 편집**이 추가됐다. 본문은 역사적 맥락으로 둔다.

`data-structure-github-sync` 브랜치 기준. (✅ 완료 / 🟡 부분 / ❌ 없음·폐기)

| 항목 | 상태 | 위치 / 비고 |
|---|---|---|
| 토큰 해석 유틸 (oklch/color-mix → rgb) | ✅ | `viz/resolveTokens.ts` (숨김 probe + getComputedStyle) |
| 챗 Mermaid 렌더 (지연로드, strict, 소스폴백) | ✅ | `viz/MermaidBlock.tsx` + `StreamingMarkdown` `rawLang==='mermaid'` |
| 에디터 NodeView (mermaid/artifact/chart/github 렌더+소스토글+↑↓편집삭제) | ✅ | `editor/cards/CodeBlockVizNodeView.tsx` |
| 챗 → 본문 삽입 버튼 | ✅ | `viz/insertIntoDoc.ts` (mermaid/artifact/**chart**) |
| **아티팩트 (임의 HTML, 격리 iframe + 주입 CSP)** | ✅ | `viz/artifactDocument.ts`(빌더+CSP+테마, 단위테스트) + `viz/ArtifactBlock.tsx`. *원래 "범위 밖(B안)"이었으나 구현* |
| 시각화 디자인 시스템 (`--viz-cat-1~6` 계열 팔레트) | ✅ | `index.css` (:root/.dark, oklch 등간격) |
| **선언형 차트 엔진** (ChartSpec → 호스트 DOM SVG) | ✅ | `viz/chartSpec.ts`(`parseChartSpec`/`parseChartObject`) + `viz/DataViz.tsx`(donut/bar/column/kpi). *Vega-Lite 대체: iframe無·보안無·테마자동* |
| Vega-Lite | ❌ 폐기 | 자체 SVG 엔진으로 대체(F3에서 vega-embed 제거). 계획 Phase 4 취소 |
| **VizNode 재귀 합성 스펙 + 렌더러** (대시보드) | ✅ | `viz/vizSpec.ts`(레이아웃 stack/columns + 리프 차트/stat/text/table, 깊이·노드 한도, 레거시 ChartSpec 하위호환) + `viz/VizRenderer.tsx` + `viz/VizBlock.tsx`. *계획에 없던 확장* |
| viz 블록 안정 id (영속·자동부여) | ✅ | `editor/vizIdPlugin.ts` + `editor/schema/fenceMeta.ts` (`v:<id>`) |
| id로 블록 찾기/교체 | ✅ | `editor/vizBlockOps.ts` (findVizById/getVizSourceById/replaceVizById) |
| **차트 편집 = 채팅 에이전트 통일** (제자리 id 교체) | ✅ | `sidecar/server.mjs` `edit_visualization` 도구 → `chat/viz-apply` → `manager.rs` 브리지 → `agent/chat/index.ts` 리스너 `replaceVizById`. ✎로 무장→일반 채팅. (커밋 `6835d57c`) |
| `/visualize` 명령어 | ❌ 폐기 | 명령어 대신 **자유 챗 자동 발행 + "본문에 삽입" 버튼**으로 대체 |

**계획 대비 주요 변경**
- **Vega-Lite 제거 → 자체 선언형 SVG 엔진**: 프롬프트로 임의 HTML 색을 강제하는 한계 → "AI는 데이터(스펙)만, 그림은 우리가". 일관성·보안면 0.
- **아티팩트(임의 HTML)**: "범위 밖"이었으나 격리 iframe(sandbox=allow-scripts, same-origin 無)+주입 CSP로 구현. 자유·인터랙티브 롱테일 담당.
- **VizNode 합성**: 단일 차트를 넘어 레이아웃(stack/columns)으로 대시보드 조립. 단일 ChartSpec은 리프로 하위호환.
- **편집을 채팅 에이전트 도구로 통일**: 별도 one-shot 파이프라인 폐기, 같은 세션에서 `edit_visualization`으로 제자리 수정.

**다음 할 일 (전부 선택 — viz는 한 단락 완성)**
1. **생성도 본문에 바로** — 지금은 챗에 그린 뒤 "본문에 삽입" 수동. 원하면 통일.
2. **선택 없이 "이름으로 차트 지목" 편집** — 문서 컨텍스트(프롬프트)에 fence의 `v:<id>`를 노출해야 가능. 현재는 plain text라 id 안 보임.
3. **플랜 B 안전망** — 에이전트가 `edit_visualization` 대신 ```chart를 챗에 그릴 때(SDK가 tool_choice 강제 불가) 그 펜스를 가로채 id에 적용. *실제로 반복될 때만.*
4. **꺾은선(line) 차트** 등 리프 종류 확장.

**잔여 리스크**: tool_choice 강제 불가 → 드물게 에이전트가 본문 대신 챗에만 차트를 그릴 수 있음(플랜 B로 보강 가능). 임의 HTML(아티팩트) 출력 조이기(few-shot/CSS 가드)는 별개로 유효.

---

## 0. 핵심 결정 (먼저 못 박을 것) — *원래 계획 (역사)*

| 질문 | 결정 | 이유 |
|---|---|---|
| MCP인가? | **아니다** | 외부 도구 연결이 아니라, 챗 화면 안에서 끝나는 **프론트엔드 렌더링** 문제다. |
| AI에게 무엇을 받나? | **선언형 명세** (Mermaid 텍스트 / Vega-Lite JSON) | 코드가 아니라 "그림 설명서"라서 **임의 코드 실행이 없음** → 격리 iframe 불필요, 보안면이 거의 없음. |
| 임의 HTML/JS도 허용? | **범위 밖 (B안)** | Anthropic식 자유도는 격리 iframe + CSP 손질이 필요. 1차 범위에서 제외. |
| Mermaid vs Vega-Lite 역할 | Mermaid=**구조/도식**, Vega-Lite=**숫자/데이터 차트** | 두 도구의 강점이 명확히 갈림. (CSV 데이터 → Vega-Lite) |
| 본문 삽입 형식 | **소스 텍스트**(` ```mermaid … ``` `) | 문서가 순수 마크다운 유지 → 이식성·git 친화·수정/되돌리기 용이. 이미지 삽입은 지양. |

---

## 1. 전체 아키텍처 (데이터 흐름)

```
 ┌───────────────┐   ① 선택      ┌──────────────┐   ② 요청       ┌───────────────┐
 │  에디터 본문   │ ───────────▶ │  챗 (AI)      │ ───────────▶ │  AI 응답       │
 │  (Milkdown)   │  scope:       │              │  /visualize   │  ```mermaid    │
 │               │  selection    │              │               │   …블록…       │
 └───────▲───────┘               └──────────────┘               └───────┬───────┘
         │                                                               │
         │ ③ 본문 삽입 (소스 텍스트)                          ②' 인라인 렌더 │
         │   pendingChangesApplier                                       ▼
 ┌───────┴───────────────────────────────────────────────────────────────────┐
 │              공용 렌더러 (Mermaid / Vega-Lite)  ◀── 디자인 토큰 주입         │
 │   · 챗:  StreamingMarkdown 의 코드블록 분기                                  │
 │   · 본문: Milkdown 코드블록 NodeView                                         │
 └─────────────────────────────────────────────────────────────────────────────┘
```

세 개의 레일 중 **①·③은 이미 존재**하고, 가운데 **"공용 렌더러"가 이번에 새로 만드는 핵심**이다.

---

## 2. 우리 코드 현황 (있는 것 / 새것)

### 이미 있음 ✅
- **선택 → 메뉴**: `editor/SelectionMenu.tsx` (드래그 시 서식·하이라이트 메뉴)
- **선택 → AI 컨텍스트**: 명령어 시스템.
  `chat/commands/builtin/*.md` 의 `scope: selection` + `{{selection}}` 슬롯,
  `chat/commands/render.ts` 가 선택 텍스트를 주입(없으면 안내).
- **AI 결과 → 본문 반영**: `state/pendingChangesApplier.ts` + 마크 앵커 시스템
  (REST가 아닌 PM 트랜잭션 + Yjs 직접 쓰기).
- **마크다운 렌더(챗)**: `chat/ui/StreamingMarkdown.tsx` — react-markdown,
  코드블록을 `pre` 컴포넌트에서 가로채 `CodeBlock`(Shiki)으로 렌더.
- **빡빡한 CSP**: `src-tauri/tauri.conf.json` → `script-src 'self' 'wasm-unsafe-eval'`
  (외부 스크립트 차단 = 라이브러리는 npm 번들 강제, 우리에게 유리).
- **디자인 토큰**: `index.css` — `--foreground/--muted/--border/--font-sans` 등
  (단, **oklch + color-mix 기반** → 아래 4.2 함정 참고).

### 새로 만듦 🔨
1. **공용 렌더러** (Mermaid 먼저, Vega-Lite 다음)
2. **챗 분기**: `StreamingMarkdown` 의 `pre` 핸들러에서 언어별 분기
3. **에디터 NodeView**: Milkdown 코드블록(`mermaid`/`vega-lite`)을 그림으로 렌더
4. **토큰 → 테마 변환 유틸** (Mermaid·Vega 공용)
5. **`/visualize` 명령어** (기존 명령어 패턴 재사용, `scope: selection`)

---

## 3. 구현 순서 (단계별 + 검증 기준)

> 원칙: 각 단계는 **독립적으로 동작하고 검증 가능**해야 한다. 중간에 멈춰도 제품 가치가 있어야 한다.

### Phase 0 — 토큰 해석 유틸 (기반)
- `resolveTokens()`: 숨긴 요소에 `var(--token)` 적용 → `getComputedStyle().color`로
  브라우저가 oklch/color-mix를 `rgb()`로 변환한 값을 읽어 반환.
- **검증**: 라이트/다크 각각에서 `--foreground` 등이 정상 `rgb()` 문자열로 나오는지 단위 확인.

### Phase 1 — 챗에 Mermaid 렌더러 ⭐ 최소 기능
- `mermaid` npm 설치(동적 import로 지연 로드), `securityLevel: 'strict'`.
- `StreamingMarkdown.tsx` `pre` 핸들러에 `lang === 'mermaid'` 분기 → `<MermaidBlock>`.
- Phase 0 토큰을 `theme: 'base'` + `themeVariables`에 주입.
- 에러 바운더리: 파싱 실패 시 **원본 코드블록으로 폴백**(절대 챗을 깨뜨리지 않음).
- 스트리밍 처리: 펜스가 **닫힌 완성 블록일 때만** 렌더(아래 4.4).
- **검증**: 챗에서 "이 과정을 순서도로 그려줘" → 도식 인라인 표시 / 잘못된 문법도
  앱이 안 죽고 코드로 보임 / 다크 전환 시 색 따라옴.

### Phase 2 — 에디터 본문 렌더러 (③ 완성용)
- Milkdown 코드블록 NodeView: 언어가 `mermaid`면 렌더 뷰, 클릭/포커스 시 소스 편집 뷰 토글.
- Phase 1의 `<MermaidBlock>`을 **재사용**(챗·본문 공용 컴포넌트).
- **검증**: 본문에 ` ```mermaid ` 블록을 직접 쓰면 그림으로 보이고, 클릭하면 편집 가능.

### Phase 3 — `/visualize` 명령어 (① → ② → ③ 연결)
- `chat/commands/builtin/visualize.md` 추가: `scope: selection`,
  "선택 내용을 Mermaid/Vega-Lite로 표현. 도식이면 ```mermaid, 데이터면 ```vega-lite".
- 결과를 본문에 넣을 때 **소스 텍스트 삽입**(pendingChangesApplier; 삽입 동작 확인).
- **검증**: 본문 드래그 → `/visualize` → 챗에 그림 → "본문에 삽입" → 문서에 소스로 들어가 렌더.

### Phase 4 — Vega-Lite 추가 (데이터/CSV)
- `vega-lite` + `vega` npm 설치(지연 로드), `vega-embed` 또는 직접 컴파일.
- `lang === 'vega-lite'` 분기 + 토큰을 Vega `config`에 주입(Phase 0 재사용).
- CSV: 사용자가 붙여넣은 표 데이터를 AI가 Vega-Lite `data`로 변환.
- **검증**: CSV 붙여넣고 "막대그래프로" → 토큰 색의 차트 표시.

### Phase 5 (선택) — 다듬기
- 다이어그램 복사/내보내기(SVG/PNG), 로딩 스켈레톤, 렌더 캐시 등.

---

## 4. 기술적 고려사항 (반드시 챙길 것)

### 4.1 보안 — "거의 없음"이지 "전혀 없음"은 아님
- 선언형이라 임의 코드 실행은 없지만, **Mermaid은 과거 라벨/`click` 디렉티브 XSS 이력**이 있다.
  → `securityLevel: 'strict'` 고정, `htmlLabels`/클릭 핸들러 비활성.
- **Vega-Lite는 안전**하나 풀 Vega의 `expr`/원격 data URL은 벡터가 될 수 있음.
  → Vega-Lite만 사용, 원격 데이터 로드 금지(우리 CSP `connect-src`가 이미 제한).
- 입력은 Anthropic 응답(준신뢰)이지만 방어적으로: 위 설정으로 잠근다.

### 4.2 디자인 토큰 주입 — oklch/color-mix 함정 ⚠️
- `var(--token)`을 Mermaid/Vega에 **직접 주면 안 됨**(색을 가공·재계산하므로 깨짐).
- 우리 토큰은 **oklch + color-mix** → 라이브러리 색 엔진이 못 읽음.
- 해결: **렌더 직전 브라우저로 변환** — 숨긴 요소에 `color: var(--token)` →
  `getComputedStyle(el).color`가 `rgb()`로 돌려줌 → 그 값을 테마에 주입.
- 결과는 **"브랜드 톤 일치"**(themeVariables 슬롯 매핑)지 픽셀 단위 복제는 아님.

### 4.3 테마/폰트 전환 시 재렌더
- Mermaid/Vega 결과물은 **정적 SVG** → 반응형 아님.
- 라이트↔다크, 폰트 변경 시 토큰을 다시 풀어 **재렌더** 필요.
- FontProvider/테마 상태에 렌더러를 구독시켜 자동 재실행.

### 4.4 스트리밍 중 부분 렌더 깨짐
- AI가 토큰을 흘리는 동안 ```mermaid 블록은 **미완성** → 파싱 실패 반복.
- 대응: **펜스가 닫힌(완성된) 블록만 렌더**, 진행 중에는 코드/플레이스홀더 표시.
- 매 토큰마다 재렌더 금지 → **소스+테마 해시로 메모이즈**(불필요한 재계산 차단).

### 4.5 번들 크기 / 성능
- Mermaid·Vega는 무겁다 → **동적 import(지연 로드)** 로 초기 로딩 영향 차단.
- 동일 다이어그램 재렌더 방지를 위한 **캐시**(소스+테마 키).

### 4.6 에디터 NodeView UX
- "보기(렌더)" ↔ "편집(소스)" 토글 정책 결정 필요(클릭 시 소스 노출 등).
- 협업/Yjs와의 정합: 노드는 결국 마크다운 코드블록이므로 동기화는 기존 경로 사용.

### 4.7 안정성 (제품 요구: 에러 없이 Well-made)
- 모든 렌더 경로에 **에러 바운더리** → 실패 시 원본 코드로 폴백, 절대 화면을 깨지 않음.
- 잘못된 AI 출력(문법 오류)은 정상 시나리오로 간주하고 우아하게 처리.

---

## 5. 리스크 / 트레이드오프

| 항목 | 트레이드오프 | 완화 |
|---|---|---|
| 표현 범위 | 선언형이라 Anthropic식 "무엇이든" 보다 제한적 | 차트+도식이 글쓰기 수요의 대부분. 필요시 추후 B안 검토 |
| 디자인 일치도 | 픽셀 일치 아님(슬롯 매핑) | 토큰→변수 매핑표를 정교화 |
| 번들 무게 | 라이브러리가 큼 | 지연 로드 + 캐시 |
| 본문 편집 UX | 렌더↔편집 토글 설계 비용 | Phase 2에서 단순 정책부터 |
| 스트리밍 | 미완성 블록 깜빡임 | 완성 블록만 렌더 + 메모이즈 |

---

## 6. 범위 밖 (이번엔 안 함)

- 임의 HTML/JS 렌더(B안): 격리 iframe + CSP 손질 필요 → 별도 과제.
- 이미지(SVG/PNG)로 본문 삽입: 에셋 관리 복잡 → 소스 텍스트 방식 우선.
- 3D(Three.js), 복잡 인터랙티브 위젯: 범위 밖.

---

## 7. 한 줄 요약

선택→컨텍스트(있음)와 AI결과→본문(있음) 사이에 **"공용 선언형 렌더러"** 한 칸을 끼우는 일이다.
**Phase 1(챗 Mermaid)** 부터 작게 시작해, 같은 컴포넌트를 에디터에 재사용하고,
`/visualize`로 흐름을 잇고, 마지막에 Vega-Lite로 데이터 차트를 확장한다.
핵심 함정은 **oklch 토큰 변환 / 스트리밍 부분 렌더 / 에러 폴백** 세 가지다.
