# Phase 4 — 파일 기반 architecture pivot

**예상 기간**: 6~8주
**선행**: Phase 3 완료 (proof-sdk / proof-server / Hocuspocus 의존 0)
**목적**: 위키 / 데일리 / chat 데이터를 IndexedDB 가 아닌 **사용자 폴더의 마크다운 파일**로 저장. CLI 도구 (grep / git / vim / qmd / MCP) 와의 결합 + 데이터 durability + Karpathy 패턴 종착점.

## 왜 이 작업이 필요한가

### 동기

- "CLI 도구도 쓰고 싶다" — 사용자 명시 신호. CLI 도구는 다 파일 시스템 위에서 동작. IDB 안 데이터는 못 봄.
- Karpathy LLM Wiki 패턴의 source — 그가 셋업한 환경은 파일 기반. qmd / MCP 등 ecosystem 도구 다 파일 기준.
- 데이터 가시성 = "Reliable, Wellmade" 가치의 한 축. 사용자가 자기 데이터를 폴더로 볼 수 있어야 신뢰.
- 미래 AI 도구 (Claude Agent SDK file tools, MCP 서버들) 와의 결합 자연스러움.

### 의식적 수용 (잃는 것)

- **Y.Doc CRDT 의 atomic Cmd+Z 마법** — markStore 의 PM transaction + Y.Map 한 묶음 마법. 4.C 에서 재설계.
- 일부 무료 기능 (다중 cursor / presence) — 어차피 사용 안 함.
- **1~2개월 사용자 가시 기능 추가 0** — 큰 작업이라 그 사이엔 인프라 작업만.
- 마이그레이션 risk — 안 하기로 결정 (dev data fresh start).

## Pre-Phase 4 — 설계 결정 (완료, 2026-05-17)

### 결정 1 — 폴더 layout

```
<vault>/                       # 사용자 선택 (기본: ~/Documents/Writer)
├── wiki/                      # entity 페이지 평평 — Karpathy 패턴
│   ├── Tom.md
│   ├── Boston.md
│   └── ...
├── daily/                     # YYYY-MM-DD 평평 — 5+ 년 한 폴더 OK
│   ├── 2026-05-17.md
│   └── ...
├── _system/                   # underscore: 시각적 메타 구분 (관례)
│   ├── conventions.md         # CLAUDE.md 역할
│   ├── log.md                 # 자동 ingest 타임라인
│   └── index.md               # 위키 페이지 카탈로그 + summary
└── threads/                   # chat thread JSON
    └── <thread-id>.json
```

- **카테고리 없음** (Karpathy 평평).
- vault 위치: 첫 실행 시 dialog → 사용자 선택 (기본 `~/Documents/Writer`). 설정에서 변경 가능.
- 빈 폴더 → fresh start. 기존 파일 있는 폴더 → 우리가 그걸 vault 로 인식 (사용자가 의도적으로 그 폴더를 선택했다고 가정).

### 결정 2 — 두 가지 사이드바 뷰

```
사이드바
├── [Daily | Files] 토글
│
├── Daily mode (현재 시각화 유지)
│   ├── 오늘 (강조)
│   ├── 어제
│   └── 최근 며칠
│
└── Files mode (신규)
    ├── wiki/
    ├── daily/
    └── _system/
```

- 같은 underlying state (vault file tree) 위 두 컴포넌트
- 사용자 선호 (Daily / Files) 는 localStorage 에 저장

### 결정 3 — 마크 storage: sidecar JSON

```
wiki/Tom.md          # 순수 마크다운 — 외부 도구 친화
wiki/Tom.marks.json  # 마크 메타데이터
```

마크 JSON 모양:

```json
{
  "marks": [
    {
      "id": "m1",
      "kind": "suggestion",
      "suggestionType": "replace",
      "quote": "Boston",
      "offsetHint": 42,
      "by": "ai:haiku-4-5",
      "createdAt": "2026-05-17T...",
      "content": "Cambridge",
      "status": "pending"
    }
  ]
}
```

**Anchor 전략 — quote + offsetHint (proof-sdk 의 `resolveQuote` 패턴):**
1. `Tom.md` 와 `Tom.marks.json` 같이 로드
2. 각 마크의 `quote` 를 본문에서 찾음
3. **한 번 발견** → 그 위치에 anchor
4. **여러 번 발견** → `offsetHint` 와 가장 가까운 거 선택
5. **0번 발견** → 마크 `status='stale'` 표시 (텍스트 사라졌음)

이미 markStore.ts 에 비슷한 로직 있음 (`isStaleMark`, `findQuoteInDoc`) — 재활용 가능.

**왜 sidecar 가 옳은가:**
- A (inline HTML span): vim 으로 열면 `<span data-proof="...">` 보임. 외부 도구 친화 의도와 충돌.
- C (footnote 변형): footnote 가 본문에 visible. 깨끗하지 않음.
- B (sidecar): 본문 깨끗 + git diff 가 의미 분리 (`.md` 텍스트 / `.json` 마크).

### 결정 4 — 외부 변경 처리

**파일이 source of truth, 메모리는 편집 buffer.** Obsidian / VS Code / iA Writer 패턴.

```
사용자가 우리 앱에서 편집     사용자가 vim 으로 편집
        │                            │
        ▼                            ▼
   메모리 buffer 변경            파일 직접 변경
        │                            │
        ▼                            │
   debounced auto-save               │
        │                            │
        ▼                            ▼
   ┌─────────── 파일 시스템 ──────────────┐
                  │
                  ▼
         file watcher (fsevents)
                  │
                  ▼
       "이건 내가 방금 쓴 거?" 분기
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   yes (echo)         no (외부 변경)
   무시               reload / 충돌 처리
```

**정책:**

- **적극적 auto-save**: idle 1초 또는 일정 간격마다 디스크 save. 미저장 buffer 시간 최소화.
- **외부 변경 + 미저장 변경 없음** → 자동 reload (조용).
- **외부 변경 + 미저장 변경 있음** → 명시적 **modal**:
  - "내 변경 유지 (외부 변경 무시, 다음 save 가 덮어씀)"
  - "외부 변경 가져오기 (내 변경 버림)"
  - "diff 보기" (옵션)
- **Echo 방지**: save 시 우리 앱이 잠깐 flag set → watcher 가 그걸 보면 무시. 표준 패턴.
- **마크 재anchoring**: 외부 변경 reload 시 quote 매칭으로 재anchor. 못 찾으면 stale.

### 결정 5 — Multi-vault: 단일 (확정)

v1 은 단일 vault. 설정 schema 는 배열로 미래 대비.

```ts
interface Settings {
  vaultPaths: string[]      // length 1 enforced in v1
  activeVaultIndex: number  // always 0 in v1
}
```

미래 multi-vault 추가 시 schema 변경 0.

### 결정 6 — Migration: 안 함 (확정)

- 옛 IDB 데이터는 그대로 둠 (Phase 4 앱이 안 봄). 4.G 에서 IDB 잔재 제거 시 자연 정리.
- Phase 4 첫 빌드 = 빈 vault → fresh start.
- 사용자가 평소 만들던 테스트 케이스 (Tom / Boston 등) 재현 5분.
- **마이그레이션 코드 = 부채 (한 번 쓰고 버리는 코드 + 검증 어려움 + Phase 4 schema evolve 시 묶임).**

## Sub-phase 분할

| Sub | 내용 | 예상 | 상태 | 핵심 산출물 |
|---|---|---|---|---|
| **4.A** | 폴더 layout + 파일 I/O 기반 | 1주 | ✅ 완료 | `vault.ts`, `vaultPicker.ts`, atomic write + echo flag |
| **4.B** | 에디터 파일 binding | 1~1.5주 | ✅ 완료 | `docFileSync.ts`: 직렬화 + observer + 2s 자동 flush + 종료 시 final flush (CloseConfirmDialog) |
| **4.C** | 마크 storage 새 모양 | 1~2주 | ✅ 완료 | `domain/internal/anchor.ts`, `quote.ts` (quote-based anchor). 단, Path C에서 `.ydoc` binary로 전환 → sidecar는 정체성 메타만 |
| **4.D** | doc 흐름 마이그레이션 | 1주 | ✅ 완료 | `docPaths.ts`에 wiki / daily / _system 매핑 + daily 하위 노트 |
| **4.E** | file watcher | 며칠 | ✅ 완료 | `vaultWatcher.ts`, `externalConflictStore.ts`, ExternalEditBanner |
| **4.F** | chat thread 이주 | 며칠 | 🚧 다음 | `threads/<id>.json` — 현재 chat thread는 아직 IDB |
| **4.G** | IDB 잔재 제거 | 며칠 | ⏳ 4.F 이후 | `y-indexeddb` dep 제거 (`package.json:80` 잔존) + 옛 코드 정리 |

## 핵심 invariant (모든 sub-phase 가 지켜야 함)

각 sub 완료 시점에 다음이 모두 동작:

1. **사용자가 vault 의 파일을 vim 으로 열어 확인 가능** — 순수 마크다운
2. **우리 앱이 vault 의 파일을 source of truth 로 인식** — 메모리는 buffer
3. **외부 변경 → 자동 반영** (적어도 reload)
4. **마크 라이프사이클 보존** — AI 제안 accept / reject / 본문 박힘 / Cmd+Z 평소대로
5. **ingest 흐름 보존** — daily 노트 → 위키 sync 정상

각 sub 단위로 머지 가능한 상태 유지. **"전부 갈아엎고 마지막에 켜기" 절대 안 함.**

## 위험 / 완충

| 위험 | 완충 |
|---|---|
| Cmd+Z atomicity 손실 | 4.C 에서 self-managed undo stack (text edit + mark.json 변경을 한 묶음 origin) 으로 재설계. Phase 1~2 디시플린 — 한 호출자씩 마이그레이션. |
| 파일 race / atomic write 누락 | atomic write helper 한 곳에서 관리 (write to tmp + rename). echo 방지 flag. |
| 외부 도구 동시 편집 충돌 | 명시적 modal, 자동 머지 시도 안 함. iA Writer / VS Code 패턴. |
| 마크 anchor stale 빈발 | quote 매칭 + offsetHint fallback. stale 상태도 UI 우아하게 표현 (이미 가지고 있는 패턴). |
| 마이그레이션 안 함의 손실 | dev data 만 있어서 risk 0. 본격 사용자 생기기 전 Phase 4 완료가 목표. |
| Tauri fs plugin 의 OS 별 quirks | macOS 우선. Linux / Windows 는 후속. |
| 큰 파일 (수MB markdown) 성능 | 4.B 의 직렬화 / 4.E 의 watcher 가 적절히 debounce. 위키 페이지는 보통 작음. |

## 보존 / 비목표

| 영역 | 처리 |
|---|---|
| Milkdown editor + 24개 커스텀 플러그인 | **전부 보존**. 데이터 source 만 바뀜. |
| Yjs | 4.A~4.B 동안 편집 layer 로 유지 — y-prosemirror 가 PM ↔ markdown round-trip 의 일부. 4.C 에서 mark 책임 분리 후 평가. |
| IndexedDB | 4.G 에서 제거. y-indexeddb dep 도. |
| markStore API | **보존**. 구현체만 교체. 호출자 변경 최소. |
| ingest / chat 흐름 | **보존**. doc read/write 만 file I/O 로 교체. |
| `apps/writer-tauri/src-tauri/` Tauri layer | 보존. plugin-fs / plugin-dialog 가 이미 Phase 1 때 도입되어 있음 — 그대로 활용. |
| 옛 Phase 4 / 5 / 6 (ingest 분해 / chat 분해 / queryWiki) | Phase 4 (이 새 plan) 완료 후 재배치. queryWiki 는 파일 기반 위에서 qmd 같은 도구 활용 가능 → 통째로 재설계 가능성. |

## 4.A 상세 — 폴더 layout + 파일 I/O 기반

(다른 sub-phase 들은 진행 직전에 detail 명문화. 4.A 만 미리 풀어둠.)

### 산출물

**1. Vault 선택 흐름**
- 첫 실행: dialog 띄움 "위키 폴더를 선택하세요. (기본: ~/Documents/Writer)"
- 사용자 선택 경로를 `settings.vaultPaths[0]` 에 저장 (localStorage 또는 Tauri store)
- 빈 폴더면 우리가 `wiki/`, `daily/`, `_system/`, `threads/` 자동 생성
- 기존 파일 있는 폴더면 그대로 인식

**2. 파일 I/O helpers**
```ts
// apps/writer-tauri/src/lib/vault.ts
export async function readVaultFile(relPath: string): Promise<string>
export async function writeVaultFile(relPath: string, content: string): Promise<void>
export async function listVaultDir(relPath: string): Promise<string[]>
export async function vaultFileExists(relPath: string): Promise<boolean>
export async function deleteVaultFile(relPath: string): Promise<void>
```

- 모든 path 는 vault 상대 경로 (`wiki/Tom.md` 등)
- 내부적으로 Tauri `plugin-fs` 호출
- atomic write: 임시 파일에 쓰고 rename (write-tmp-then-rename 패턴)

**3. Echo 방지 flag**
```ts
// apps/writer-tauri/src/lib/vault.ts
const recentWrites = new Map<string, number>()  // path → timestamp

export async function writeVaultFile(...) {
  await atomicWrite(...)
  recentWrites.set(relPath, Date.now())
}

export function isOurRecentWrite(relPath: string): boolean {
  const t = recentWrites.get(relPath)
  return t !== undefined && Date.now() - t < 500  // 500ms window
}
```

watcher 에서 `isOurRecentWrite()` 가 true 면 무시.

**4. 설정 schema**
```ts
// apps/writer-tauri/src/state/settings.ts
interface Settings {
  vaultPaths: string[]
  activeVaultIndex: number
}
```

### 검증
- vault 선택 흐름 dialog 동작
- `writeVaultFile('wiki/Test.md', '# Hello')` → 디스크에 파일 생김
- `readVaultFile('wiki/Test.md')` → `'# Hello'` 반환
- Finder 에서 vault 폴더 열면 우리가 만든 파일 보임
- atomic write: write 도중 앱 종료해도 partial file 안 생김 (tmp 파일은 남을 수 있음, 다음 부팅 시 정리)

### 비목표 (4.A 에서 안 함)
- 에디터 binding (4.B 영역)
- 마크 storage (4.C)
- file watch (4.E)

## 다음 단계

1. 4.A 시작 — 폴더 layout + 파일 I/O 기반 구현
2. 4.B 진행 직전 detail 명문화
3. (반복)

---

각 sub-phase 마무리 시점에 README 의 상태 표 + 이 문서의 sub-phase 표를 같이 업데이트.
