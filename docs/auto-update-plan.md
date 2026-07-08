# Auto-Update 구현 계획 (tauri-plugin-updater)

> Dogfooding을 시작하기 전에, 본인 및 외부 사용자에게 안전하게 새 버전을 배포하기 위한 자동 업데이트 시스템 설계 및 구현 계획.

> **2026-06-21 갱신 — 결정·구현 현황**
> - 제품명 `Octave`, 번들 ID `com.minkyojung.octave`, 버전 `0.0.1` 확정.
> - 호스팅: **자체 도메인(R2) 대신 GitHub Releases**로 시작 (`minkyojung/edit`, public).
>   매니페스트 endpoint = `https://github.com/minkyojung/edit/releases/latest/download/latest.json`.
> - 채널 분리(canary/stable)는 **지금은 안 함** — 혼자 dogfooding이라 stable 단일. 외부 사용자 생기면 pre-release로 도입.
> - Tauri updater 서명 키 생성 완료 → 1Password "Octave — Tauri Updater Signing Key" (private key + password), 로컬 `~/.tauri/octave.key`. pubkey는 tauri.conf.json에 박힘.
> - **코드 구현 완료**: tauri.conf.json(updater 플러그인+createUpdaterArtifacts), Cargo(updater/process), capabilities, lib.rs 등록 + Writer→Octave 리네임, 프론트 `src/lib/updater.ts`(런처 윈도우에서 시작 5초 후 + 1시간마다 check→다운로드→재시작 토스트).
> - **남은 것**: Apple 인증서/공증 발급(가입은 완료) → 첫 수동 빌드+서명+공증 → GitHub 릴리스에 번들+latest.json 업로드 → 자동 업데이트 실측. 그 후 CI 자동화.
> - 아래 본문의 `Rabat`/`rabat.app`/R2 가정은 **구버전 기준**이라 위 결정으로 대체됨.

## 1. 배경 및 결정

### 왜 Auto-Update가 필요한가
- Dogfooding은 "본인이 먼저 고통을 겪는다"가 핵심. 매 버그 수정마다 DMG 받기 → 삭제 → 재설치를 반복하면 며칠 안에 옛날 버전에 머무르게 됨.
- 첫 배포 버전에 업데이터가 없으면 그 버전 사용자는 영원히 수동 업데이트해야 함.
- 인프라 셋업은 느린 부분 (Apple 승인, 인증서 발급) — 기능 개발과 병렬로 진행 가능.

### Sparkle을 안 쓰는 이유
| 항목 | Sparkle | tauri-plugin-updater |
|---|---|---|
| 플랫폼 | macOS only | macOS/Win/Linux |
| Tauri 통합 | 어색 (FFI) | 공식 플러그인 |
| 호스팅 | 정적 OK | 정적 OK |
| UX 제어 | 프레임워크가 잡음 | JS로 자유 제어 |

### Notion / Linear 사례
- 둘 다 Electron 내장 `autoUpdater` (Squirrel.Mac) 사용
- 핵심 모델: **정적 매니페스트 + 서명된 번들을 CDN에 호스팅 → 클라이언트가 주기적으로 체크 → 백그라운드 다운로드 → 재시작 시 교체**
- `tauri-plugin-updater`는 이 모델을 그대로 따름

## 2. 아키텍처

### 두 가지 서명 (둘 다 필수)
| 서명 | 검증 주체 | 목적 | 비용 |
|---|---|---|---|
| **Apple codesign + notarize** | macOS Gatekeeper | "Apple 등록 개발자가 만든 앱" | Apple Developer $99/년 |
| **Tauri updater signature** | Rabat 앱 자체 | "내가 만든 진짜 업데이트 번들" | 무료 (로컬 키 생성) |

- Apple 서명만 → 매니페스트 가로채기 공격에 취약
- Updater 서명만 → Gatekeeper에 막혀 실행 불가
- → **반드시 둘 다**

### 전체 흐름
```
[CI: tag push v0.4.2]
  1. cargo tauri build
  2. Apple codesign (Developer ID 인증서)
  3. Apple notarize (xcrun notarytool, ~5분)
  4. Tauri 업데이터 번들 생성 → .app.tar.gz + .app.tar.gz.sig
  5. R2/S3에 업로드: Rabat_0.4.2.app.tar.gz + latest.json

[유저 앱]
  1. 시작 시 + 1시간마다 latest.json GET
  2. version 비교 → 새 버전이면 다운로드
  3. .sig를 pubkey로 검증 → 실패 시 폐기
  4. 토스트: "재시작하면 업데이트됩니다"
  5. 유저가 재시작 → 새 .app으로 교체 → 실행
```

### 채널 분리 (필수)
호스트 경로로 분리:
- `https://updates.rabat.app/canary/{{target}}/{{arch}}/{{current_version}}` (본인)
- `https://updates.rabat.app/stable/{{target}}/{{arch}}/{{current_version}}` (외부)

채널 분리가 없으면 본인 실험 버전이 모든 사용자에게 즉시 전파됨.

### 매니페스트 포맷 (`latest.json`)
```json
{
  "version": "0.4.2",
  "notes": "버그 수정 및 성능 개선",
  "pub_date": "2026-05-21T10:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "(.sig 파일 내용)",
      "url": "https://updates.rabat.app/Rabat_0.4.2_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "...",
      "url": "https://updates.rabat.app/Rabat_0.4.2_x86_64.app.tar.gz"
    }
  }
}
```

## 3. 구현 단계

### Phase 0 — 사전 결정 (지금 확정)

#### 현재 설정 (`apps/writer-tauri/src-tauri/tauri.conf.json`)
```json
"productName": "Writer",
"version": "0.1.0",
"identifier": "com.conductor.writer"
```

#### 결정 항목

**(1) 제품 이름 (`productName`)** — 사용자에게 보이는 이름 (Dock, Finder, 메뉴바)
- 현재: `"Writer"`
- 워크스페이스명은 `rabat`인데 app 이름이 `Writer`라 불일치 — 정리 필요
- 선택지: `"Writer"` / `"Rabat"` / 기타

**(2) 번들 ID (`identifier`)** — macOS가 앱을 식별하는 유일 키
- 현재: `"com.conductor.writer"`
- **한 번 배포하면 못 바꿈.** 바꾸면 별개 앱으로 인식 → 자동 업데이트 끊김 + 데이터 분리
- 형식: 역방향 도메인 (`com.소유자.제품`)
- 선택지:
  - 본인 소유 도메인 기반: `com.williamjung.rabat` (권장 — 미래에 회사/조직 바뀌어도 안정적)
  - 조직 기반 유지: `com.conductor.writer`
  - 미래 회사 도메인: `com.<future-company>.rabat`

**(3) 버전 시작점 (`version`)** — semver (major.minor.patch)
- 현재: `"0.1.0"`
- Dogfooding 단계는 `0.x.x`, 외부 공개 시 `1.0.0`
- 선택지: `"0.0.1"` (더 보수적) / `"0.1.0"` (현재 유지)

**(4) 채널 정책** — 매니페스트 호스팅 경로 구조
- 권장: `canary` (본인) + `stable` (외부) 2채널 시작
- URL 패턴: `https://updates.<domain>/<channel>/{{target}}/{{arch}}/{{current_version}}`

#### 권장안
```json
"productName": "Rabat",
"version": "0.0.1",
"identifier": "com.williamjung.rabat"
```

#### 결정 기록 (2026-06-21 확정)
- [x] `productName`: `Octave`
- [x] `identifier`: `com.minkyojung.octave`
- [x] `version`: `0.0.1`
- [x] 채널: stable 단일 (canary/stable 분리는 외부 사용자 생길 때)
- [x] 호스팅: GitHub Releases (`minkyojung/edit`)

### Phase 1 — Apple 행정 (1~2일, 병렬 진행)
- [ ] Apple Developer Program 가입 ($99/년)
- [ ] Developer ID Application 인증서 발급
- [ ] 인증서를 .p12로 export
- [ ] App-specific password 생성 (notarization용)
- [ ] Team ID 확인

### Phase 2 — Tauri Updater 키 + 설정 (2~3시간)
- [ ] `tauri signer generate -- -w ~/.tauri/rabat.key` 로 키 발급
- [ ] `tauri.conf.json` 수정:
  ```json
  {
    "bundle": { "createUpdaterArtifacts": true },
    "plugins": {
      "updater": {
        "pubkey": "<publickey.pem 내용>",
        "endpoints": [
          "https://updates.rabat.app/canary/{{target}}/{{arch}}/{{current_version}}"
        ]
      }
    }
  }
  ```
- [ ] `Cargo.toml`에 `tauri-plugin-updater` 추가
- [ ] `src-tauri/capabilities/default.json`에 권한 추가:
  ```json
  { "permissions": ["updater:default", "process:allow-relaunch"] }
  ```
- [ ] `lib.rs`에 플러그인 등록

### Phase 3 — 앱 UI (반나절)
- [ ] 시작 시 + 1시간마다 `check()` 호출
- [ ] 업데이트 발견 시 백그라운드 다운로드
- [ ] 다운로드 완료 시 우측 하단 토스트:
  - "v0.4.2 준비됨 [지금 재시작]"
  - 무시하면 다음 앱 시작 시 자동 적용
- [ ] `minimum_version` 필드 체크 → 강제 업데이트 모달 (마이그레이션 깨질 때 대비)

### Phase 4 — 첫 배포 (수동, 반나절)
- [ ] 로컬에서 빌드 + 서명 + 공증
- [ ] R2 버킷 생성, 도메인 연결 (`updates.rabat.app`)
- [ ] 첫 번들 + `latest.json` 업로드
- [ ] 본인이 v0.0.1 → v0.0.2 자동 업데이트 테스트
- [ ] 깨지는 거 다 잡기

### Phase 5 — CI 자동화 (나중에)
- [ ] GitHub Actions에 시크릿 등록:
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- [ ] tag push 시 자동 빌드/서명/공증/업로드 워크플로우
- [ ] `latest.json` 자동 갱신

## 4. 실제 유저 경험

### 시나리오 A — 평범한 업데이트 (대부분)
```
09:00  유저가 Rabat 실행
09:00  (보이지 않음) 매니페스트 체크 → 새 버전 발견
09:01  (보이지 않음) 백그라운드 다운로드 완료
09:01  우측 하단 토스트: "v0.4.2 준비됨 [지금 재시작]"
14:00  유저가 일 끝나고 앱 종료
다음 날 앱 시작 시 자동으로 v0.4.2로 실행
```
유저 클릭 수: **0번** (또는 토스트 클릭 1번)

### 시나리오 B — 강제 업데이트 (DB 마이그레이션 변경)
```
09:00  유저 실행 → 매니페스트에 minimum_version: "0.4.2" 발견
09:00  현재 버전 0.4.1 < 0.4.2 → 차단 모달
        "필수 업데이트가 있습니다. 자동으로 적용됩니다."
09:01  다운로드 → 자동 재시작 → v0.4.2 실행
```
유저 클릭 수: **0번**

### 시나리오 C — 네트워크 오류
```
체크 실패 → 조용히 무시 → 다음 주기에 재시도
```
유저에겐 아무것도 안 보임. 텔레메트리에만 기록.

## 5. 한계와 대응

| 한계 | 영향 | 대응 |
|---|---|---|
| 델타 업데이트 없음 | 매번 전체 번들 다운로드 (~50~80MB) | 앱 크기 관리 |
| 다운로드 재개 없음 | 네트워크 끊기면 처음부터 | 재시도 로직 |
| 롤백 자동화 없음 | 새 버전 깨지면 수동 대응 | `latest.json` 되돌리기 + `version_comparator` 다운그레이드 허용 |
| Windows 강제 종료 | 설치 중 앱 강제 닫힘 | macOS 우선이라 무시 |

## 6. 텔레메트리 (Day 1 필수)

dogfooding 중에 "내 버전이 뭔지" 모르면 버그 리포트가 무의미해짐.

최소 측정 항목:
- [ ] 앱 시작 시 현재 버전 + OS + arch 핑
- [ ] 매니페스트 체크 성공/실패
- [ ] 다운로드 성공/실패 + 소요 시간
- [ ] 서명 검증 실패 (보안 사고 신호 — 즉시 알림)
- [ ] 설치 후 첫 실행 성공 여부

## 7. 비용

| 항목 | 비용 |
|---|---|
| Apple Developer | $99 / 년 |
| Cloudflare R2 호스팅 | 무료 티어 내 (10GB 저장 / 월 1M 요청) |
| GitHub Actions | 무료 (퍼블릭 repo) / 2000분 (프라이빗) |
| Tauri updater 키 | 무료 |
| **합계** | **~$99 / 년** |

## 8. 진행 순서 (권장)

```
Day 1 (오늘)
  ├─ Phase 0: 번들 ID / 버전 / 채널 확정
  └─ Phase 1 시작: Apple Developer 가입 (병렬, 기다리는 중)

Day 2~3 (Apple 승인 기다리는 동안)
  └─ Phase 2: tauri-plugin-updater 통합 + 키 발급

Day 4 (Apple 인증서 받은 후)
  ├─ Phase 3: 앱 UI 작업
  └─ Phase 4: 수동으로 첫 배포 + 자동 업데이트 테스트

Day 5~ (안정화 후)
  └─ Phase 5: CI 자동화
```

## 9. 미정 / 추후 결정 항목

- [ ] 호스팅 도메인 (`updates.rabat.app`? GitHub Releases?)
- [ ] 텔레메트리 백엔드 (PostHog? Plausible? 직접 구현?)
- [ ] 외부 dogfooder 모집 시점 및 방식
- [ ] 강제 업데이트 모달 UI 디자인
- [ ] 릴리스 노트 작성/표시 정책

## 참고 링크

- [tauri-plugin-updater 공식 문서](https://v2.tauri.app/plugin/updater/)
- [Tauri macOS 코드 서명](https://v2.tauri.app/distribute/sign/macos/)
- [Apple Developer Program](https://developer.apple.com/programs/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
