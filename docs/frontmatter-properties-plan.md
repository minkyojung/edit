# Frontmatter Properties (옵시디언식) 구현 계획

> 목적: 제목과 본문 **사이**에, 노트의 frontmatter를 옵시디언 Properties처럼
> **렌더된 편집 가능한 패널**로 띄운다. 임의 키 + 타입 지정 + 리스트(tags)까지.
> 방식: frontmatter를 CM 버퍼에 넣지 않는다. **진실의 원천은 스토어(`KnownDoc`)**,
> 패널은 그걸 읽고 쓰고, 기존 flush가 `composeFrontmatter`로 파일에 반영한다.

---

## 0. 확정된 설계 결정

- **타입: 타입맵(type map) 채택.** 값에서 매번 추론하지 않고, `key → type`을
  볼트 전역에 기록한다. 빈 리스트가 텍스트로 튀는 문제, 숫자꼴 텍스트 오인,
  사용자가 타입을 못 고정하는 문제를 없앤다. (추론은 타입맵을 **처음 채우는
  seed**로만 쓴다 — 아래 4장.)
- **호스트 필드: 기본 숨김 + 유저가 원하면 표시.** 시스템 관리 키
  (`slug`, `createdAt` 등)는 패널에서 기본적으로 안 보이되, "시스템 속성 보기"
  토글로 펼치면 **읽기 전용(잠금)** 으로 표시한다. 편집은 여전히 불가.
- **버퍼 불가침.** 지금처럼 CM 버퍼에는 body-only 마크다운만. frontmatter는
  스토어 상태 ↔ 파일 사이만 오간다. IME/undo/직렬화 전제와 충돌 없음.
- **소유권 이동.** 지금은 임의 키를 "저장 시 디스크를 다시 읽어" 보존하지만
  (`docFileSync.ts:522~533`), 이 계획 후엔 **스토어가 임의 키의 원본**이 된다.
  그 우회 로직은 제거/대체한다(진실의 원천 이중화 방지).

---

## 1. 현재 구조 (출발점)

세 값이 이미 물리적으로 분리돼 있다.

| 값 | 사는 곳 | 비고 |
|----|---------|------|
| 제목 | `KnownDoc.title` → `PageHeader`/`EditableTitleInput` (React) | 본문 밖 |
| 본문 | CM 버퍼 `handle.bodyMarkdown` | **frontmatter 제거된 body** |
| frontmatter | `KnownDoc`의 타입 필드들 (`DocMetaFile` 셰이프) | flush가 재조립 |

읽기/쓰기 파이프라인:

- **읽기(카탈로그)**: `scanVault.ts:65` → `splitFrontmatter(raw).data` →
  `frontmatterToMeta(data)`(**모르는 키 버림**) → `mdRelToKnownDoc` → `KnownDoc`.
- **읽기(본문)**: `handlesSlice.loadBodyMarkdown` → `splitFrontmatter(raw).body`만
  CM에 실음.
- **쓰기**: 500ms flush(`docFileSync.flushDirtyOnce`) →
  `metaToFrontmatterFields(meta)` + (임의 키는 디스크 재읽기로 보존) →
  `composeFrontmatter(fields, body)` → 파일.

렌더 트리 삽입 지점은 이미 존재한다 — `CmEditor.tsx:355`:

```tsx
{header}                                        {/* 제목 */}
<div className="cm-prototype" ref={rootRef} />  {/* 본문 */}
```

이 두 줄 사이가 패널 자리다.

### 지금의 한계 (이번에 넘어야 할 벽)

1. `frontmatterToMeta`가 **임의 키를 무시** → 스토어가 사용자 프로퍼티를 모름.
2. `frontmatter.ts`의 파서/직렬화기가 **한 줄 스칼라만** 지원 → 리스트(tags)
   블록 시퀀스를 못 읽고 못 쓴다. (**가장 큰 작업 덩어리**)
3. 타입 개념이 아예 없음 → 타입맵 저장소가 필요.

---

## 2. 데이터 모델

### 2.1 타입 (`src/lib/properties/types.ts` 신설)

```ts
export type PropertyType =
  | 'text'      // 문자열
  | 'list'      // 문자열 배열 (tags)
  | 'number'    // 숫자
  | 'checkbox'  // 불리언
  | 'date'      // YYYY-MM-DD
  | 'datetime'  // ISO 8601

export type PropertyValue = string | string[] | number | boolean

/** 순서 보존이 핵심 — YAML 출력 순서가 흔들리면 diff가 튄다. */
export interface Property {
  key: string
  value: PropertyValue
  // 타입은 Property에 안 박는다. 타입맵(전역)이 단일 출처.
}
```

### 2.2 스토어 확장 (`KnownDoc`)

```ts
export interface KnownDoc {
  // ...기존 필드...
  /** 사용자 프로퍼티. 호스트 관리 키를 제외한 frontmatter의 나머지.
   *  순서 있는 배열 — YAML 출력 순서를 그대로 보존. */
  properties?: Property[]
}
```

- 호스트 관리 필드(`slug`/`createdAt`/`archivedAt`/… 전부 `DocMetaFile` 키)는
  **지금처럼 타입 필드로 유지.** `properties`엔 안 들어간다.
- `HOST_MANAGED_KEYS`를 한 곳에 상수로 정의(`docPaths.ts` 근처).
  `metaToFrontmatterFields`가 내보내는 키 집합과 **정확히 일치**해야 하며,
  라운드트립 테스트로 고정한다(둘이 어긋나면 CI 실패).

### 2.3 타입맵 저장소 (볼트 전역)

- **위치**: 볼트 루트 `.writer/property-types.json`
  (`.meta.json` 사이드카와 같은 볼트 쓰기 경로 재사용).
  ```json
  { "tags": "list", "status": "text", "due": "date", "rating": "number" }
  ```
- **왜 전역인가**: 옵시디언과 동일. `tags`는 노트마다 타입이 달라선 안 됨.
  한 곳에서 관리 → 일관성 + 타입 변경이 볼트 전체에 즉시 적용.
- **런타임**: 부팅 시 1회 로드 → 작은 Zustand 스토어 `propertyTypesStore`
  (`get(key)`, `set(key, type)`, `all()`). 변경 시 파일에 씀.
- **동시성/워처**: 파일 쓰기는 기존 `writeVaultFile`(에코 억제) 사용.
  `vaultWatcher`가 이 파일 변경을 무시하도록 예외 등록(외부 편집은 드묾,
  다음 부팅에 반영되면 충분).
- **부팅 seed**: 파일이 없으면 `{}`로 시작. 스캔 중 타입맵에 없는 키를 만나면
  **값에서 1회 추론**해 맵에 기록(아래 4장). 이후엔 맵이 authoritative.

---

## 3. YAML 표현력 확장 (`src/lib/frontmatter.ts`)

> **이 장이 가장 리스크가 크다.** 먼저 `frontmatter.test.ts`에 round-trip
> 테스트를 깔고 들어간다.

현 파서는 `key: value` 한 줄만 읽고, 직렬화도 스칼라만 낸다. 리스트를 위해
**블록 시퀀스**를 양방향 지원해야 한다.

### 3.1 파서 (`splitFrontmatter`)

```yaml
tags:
  - writing
  - idea
status: draft
```

- `key:` 뒤 값이 비고, 다음 줄들이 `  - ` 들여쓰기 시퀀스면 **배열로 파싱**.
- 인라인 `[a, b]` 형식도 허용(옵시디언 저장형 중 하나) → 배열.
- 반환 타입 확장: `data: Record<string, string | string[]>`.
- 기존 스칼라 경로는 그대로 (하위호환).

### 3.2 직렬화 (`composeFrontmatter`)

- 배열 값 → 블록 시퀀스로 출력(빈 배열은 키 생략 or `key: []` — **정책 확정
  필요**, 아래 6장).
- 스칼라 → 지금의 escape 규칙 유지.
- 타입 정보로 포맷을 결정(number는 따옴표 없이, date는 `YYYY-MM-DD` 등).

### 3.3 경계 유지

- 중첩 객체/멀티라인 문자열은 **범위 밖**. 옵시디언 기본 타입엔 없다.
  여기서 선을 넘으면 진짜 YAML 파서(`yaml` 패키지)를 들여야 하므로, **배열까지가
  이 hand-rolled 모듈의 한계선**임을 주석에 명시.

---

## 4. 타입 결정 로직 (타입맵 + 추론 seed)

값을 타입으로, 타입을 값으로 옮기는 코어. `src/lib/properties/coerce.ts`.

### 4.1 읽기 (raw → typed)

```
for each 사용자 프로퍼티 key:
  type = propertyTypesStore.get(key)
  if (type 없음):                       // 맵에 처음 보는 키
    type = inferType(rawValue)          // 1회 추론 (seed)
    propertyTypesStore.set(key, type)   // 맵에 기록 → 이후 authoritative
  value = coerceToType(rawValue, type)  // 'true'→boolean, '5'→number, 배열 유지
```

- `inferType`: 배열→list, `true/false`→checkbox, 숫자꼴→number,
  `YYYY-MM-DD`→date, 나머지→text. **추론은 오직 맵에 없는 키의 초기값**으로만.
- 한 번 맵에 들어가면 값이 바뀌어도 타입은 유지(사용자가 명시 변경 전까지).

### 4.2 쓰기 (typed → raw)

- 타입맵의 타입에 맞춰 YAML 포맷 결정 후 `composeFrontmatter`에 전달.

### 4.3 타입 변경 (UI)

- 패널에서 타입 아이콘 클릭 → 새 타입 선택 → `propertyTypesStore.set(key, type)`
  → 볼트 전역 적용 → 열려 있는 노트들의 해당 프로퍼티 재해석.
- 변환 규칙 정의 필요: text→list는 단일 원소 배열, list→text는 join(", "),
  변환 불가(text "abc"→number)는 값 비우거나 원본 보존 후 경고.

---

## 5. 읽기/쓰기 파이프라인 배선

### 5.1 읽기 (카탈로그)

- `scanVault.mdRelToKnownDoc` / `frontmatterToMeta` 호출부에서:
  1. 기존대로 호스트 키 → `meta`.
  2. **신규**: 호스트 키 제외한 나머지 → `coerce`로 타입화 → `KnownDoc.properties`.
- 본문 로드(`loadBodyMarkdown`)는 변경 없음(여전히 body만).

### 5.2 쓰기 (flush)

`docFileSync.flushDirtyOnce`에서 최종 파일 조립 순서:

```
호스트 필드(metaToFrontmatterFields) + 사용자 프로퍼티(KnownDoc.properties)
   → 순서 보존해 병합 → composeFrontmatter(fields, body)
```

- **삭제**: 지금의 "디스크 재읽기로 임의 키 보존"(522~533) 로직은 제거.
  이제 스토어가 임의 키의 원본이므로 불필요하고, 두면 이중 출처가 된다.
- **순서**: `properties` 배열 순서대로 출력 → 사용자가 본 순서 = 파일 순서 =
  안정적 diff.

### 5.3 편집 → 저장 흐름

- 패널 편집 → 스토어 setter(`upsertProperty`/`removeProperty`/`renameProperty`)
  → `markSlugDirty` → 기존 500ms flush가 자동 반영. 패널이 파일을 직접 안 만짐.

---

## 6. UI — Properties 패널

### 6.1 배치

- `CmEditor.tsx:355`의 `{header}`와 `.cm-prototype` 사이에
  `<PropertiesPanel slug={slug} />` 삽입. 750px 컬럼 안, 제목 바로 아래.

### 6.2 구성

- **사용자 프로퍼티 행들** (편집 가능):
  - `[타입 아이콘] key : [값 에디터]`
  - 값 에디터는 타입별: text=인풋, list=칩 입력, number=숫자 인풋,
    checkbox=토글, date/datetime=날짜피커.
  - 타입 아이콘 클릭 → 타입 변경 메뉴(→ 전역 타입맵).
  - 행 hover 시 삭제, 키 클릭 시 리네임.
- **"+ 속성 추가"**: 키 입력 + 타입 선택 → `upsertProperty`.
  예약 키(호스트 관리 키) 입력은 차단.
- **시스템 속성 (기본 접힘)**: "시스템 속성 보기" 토글 → 호스트 필드
  (`slug`, `createdAt`, `sourceUrl`…)를 **읽기 전용(회색·잠금)** 으로 표시.
  편집 불가. 값 없는 필드는 숨기거나 `—`.
- 프로퍼티가 하나도 없으면 패널은 "+ 속성 추가"만 있는 얇은 줄.

### 6.3 감성 디테일 (옵시디언 참고)

- 키는 소문자 정규화, 값 없을 때 회색 placeholder, 패널 전체 접기/펼치기,
  본문과의 간격은 제목–본문 리듬에 맞춤.

---

## 7. 엣지 케이스 · 리스크

| 리스크 | 대응 |
|--------|------|
| **YAML 배열 파싱**(최대 리스크) | round-trip 테스트 선행, 인라인/블록 둘 다 커버 |
| 빈 리스트 vs 텍스트 모호성 | **타입맵으로 해결됨**(선택 이유) — 값 비어도 타입 유지 |
| 출력 순서 흔들림 → diff 노이즈 | `properties` 순서 배열로 보존 |
| 호스트 키 충돌(사용자가 `slug` 생성) | 예약 키 입력 차단 |
| 이중 출처(디스크 재읽기 보존 로직) | 해당 로직 제거, 스토어를 단일 출처로 |
| 타입맵 파일 외부 편집 | 워처 예외 + 다음 부팅 반영 |
| 손상된 frontmatter(수기 편집) | `splitFrontmatter`는 never-throw 유지, 파싱 실패 키는 건너뜀 |
| 빈 배열 직렬화 정책 | **확정 필요**: 키 생략 vs `key: []` (권장: 키 유지, `[]`) |
| 타입 변경 시 값 변환 불가 | 원본 보존 + 사용자 경고, 데이터 삭제 금지 |

---

## 8. 작업 순서 (goal-driven)

```
1. 타입/상수: PropertyType, Property, HOST_MANAGED_KEYS 정의
   → verify: metaToFrontmatterFields 키 집합 == HOST_MANAGED_KEYS (round-trip 테스트)

2. YAML 확장: frontmatter.ts 파서/직렬화기 블록 시퀀스 지원  ← 최대 리스크
   → verify: frontmatter.test.ts 배열 round-trip 통과(블록+인라인)

3. 타입맵 스토어: propertyTypesStore + .writer/property-types.json 로드/저장
   → verify: 부팅 로드, set 후 파일 반영, 없으면 {} 시작

4. coerce: inferType(seed) + coerceToType(양방향)
   → verify: 각 타입 raw↔typed 단위 테스트

5. 읽기 배선: scanVault에서 사용자 프로퍼티 → KnownDoc.properties
   → verify: tags 있는 .md 열면 properties에 배열로 뜸

6. 쓰기 배선: flush 병합(호스트+사용자, 순서 보존), 재읽기 보존 로직 제거
   → verify: 값 변경 → .md 반영 → 재부팅 후 유지, diff 순서 안정

7. UI: PropertiesPanel(타입별 행/추가/삭제/리네임 + 시스템 속성 토글)
   → verify: 실앱에서 CRUD 동작, 시스템 속성 읽기전용 표시

8. 타입 변경 UI: 아이콘 → 타입 메뉴 → 전역 맵 + 값 변환
   → verify: tags를 text로 바꾸면 볼트 전역 재해석, 변환 불가 시 경고
```

**착수 지점: 2번(YAML 배열 지원)** 부터. 여기가 뚫리면 나머지는 배선/UI다.
2번 착수 전 `frontmatter.test.ts`에 실패하는 round-trip 테스트부터 작성한다.

---

## 9. 범위 밖 (이번 제외)

- 중첩 객체 / 멀티라인 문자열 타입 (진짜 YAML 파서 필요).
- 프로퍼티 키를 볼트 전역에서 일괄 리네임(옵시디언 고급 기능).
- 프로퍼티 기반 쿼리/필터 뷰(dataview류).
