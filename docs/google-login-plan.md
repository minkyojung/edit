# Google 로그인 구현 계획

> 목적: Google 로그인으로 유저의 **이름 · 프로필 사진 · 이메일**을 수집한다.
> 추후 Gmail 읽기까지 스코프를 넓힐 수 있도록 골격을 잡는다.
> 방식: 백엔드 없이 데스크톱 앱이 직접 처리 (PKCE) + 자동완료(loopback) 콜백.

---

## 0. 배경 결정 사항

- **제공자: Google** (GitHub 아님). 이메일 확보율·유저 커버리지·프로필(name/picture/email 한 번에)에서 우위.
- **백엔드 없음.** 이 앱은 이미 Claude(PKCE) / GitHub(Device Flow) 로그인을 백엔드 없이
  구현해 실사용 중. Google도 같은 구조를 따른다. (`gcloud`, `gh`, VS Code와 동일한 업계 표준 = RFC 8252)
- **토큰 저장: 기존 `secure_storage.rs` 재사용** (AES-256-GCM, machine-uid 파생 키).
  OS 키체인 대신 이 방식을 쓰는 이유는 코드 주석 참고(개발 중 반복 프롬프트 회피).
- **콜백: 자동완료(loopback)** 채택. `http://127.0.0.1:<port>` 임시 서버로 code 수신.
  Claude식 코드 붙여넣기보다 UX가 매끄러움.

### 점진적 확장(Incremental authorization) 정정
Google 공식 문서: **"Incremental authorization is not supported for installed apps."**
- `include_granted_scopes`(자동 병합)는 설치형 앱에서 미지원.
- 단, **나중에 더 넓은 스코프로 다시 로그인**하는 방식은 가능 →
  Gmail 켤 때 `openid email profile gmail.readonly` 전체를 재요청 → 유저 추가 동의 → 넓은 토큰 발급.
- 결론: "지금 좁게 → 나중에 넓히기"는 **가능**. 다만 자동으로 얹히는 게 아니라 재인증 형태.
- 참고: **설치형 앱은 refresh token이 항상 발급됨** → `access_type=offline` 불필요.

---

## 1. 범위

**이번(1단계):**
- 스코프: `openid email profile`
- 이름 · 프로필 사진 · 이메일 수집, 프로필 저장, 설정 화면 표시

**이번 제외:**
- Gmail 읽기 (나중에 넓은 스코프로 재인증. 골격은 지금 그대로 재사용)

---

## 2. Google Cloud Console 설정 (코드 아님 · 선행 작업)

> 콘솔 UI는 2025년 개편으로 "OAuth consent screen" → **"Google Auth Platform"**.
> 시작: https://console.cloud.google.com

### 1단계. 프로젝트 생성
1. 상단 프로젝트 드롭다운 → **New Project**
2. 이름 입력(예: `writer-tauri-auth`) → **만들기**
3. 상단 드롭다운에서 해당 프로젝트가 선택돼 있는지 확인
- 검증: 상단에 방금 만든 프로젝트 이름 표시.

### 2단계. Google Auth Platform 구성 (동의 화면)
1. APIs & Services → **OAuth consent screen** (= Google Auth Platform) → **Get started**
2. 입력:
   - App Information: 앱 이름(예: `Writer`), 지원 이메일
   - Audience: **External** 선택 (조직 계정 아니면 이것만 가능 — 정상)
   - Contact Information: 개발자 이메일
   - 약관 동의 → **만들기**
- 검증: Branding / Audience / Clients / Data Access 탭이 보임.

### 3단계. 스코프 등록 (Data Access)
1. **Data Access** 탭 → **Add or remove scopes**
2. 추가:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
3. **Update → Save**
- **Gmail 스코프는 지금 넣지 않음** (심사가 무거워짐). 나중에 여기서 `gmail.readonly` 추가.
- 검증: 표에 email/profile/openid 3개 표시.

### 4단계. 테스트 사용자 등록 (Audience)
1. **Audience** 탭 → Publishing status = **Testing** 확인
2. **Test users → Add users** → **본인 Gmail** 추가 → 저장
- 왜: Testing 상태에선 등록된 테스트 유저만 로그인 가능.
- 검증: Test users 목록에 본인 이메일 존재.

### 5단계. OAuth 클라이언트 ID 생성 (핵심)
1. **Clients** 탭 → **Create client**
   (구 경로: Credentials → Create Credentials → OAuth client ID)
2. Application type: **Desktop app** ← 반드시
3. 이름 입력 → **만들기**
4. **Client ID + Client secret** 확보 (복사/JSON 다운로드)
- **redirect URI를 묻지 않음** — Desktop 타입은 loopback(127.0.0.1) 자동 허용. 정상.
- 검증: `xxxxx.apps.googleusercontent.com` 형태 Client ID 확보.

### 6단계. 발급물 전달
- **Client ID**: 비밀 아님. 코드에 심어도 됨(Claude/GitHub Client ID도 그렇게 처리됨).
- **Client secret (Desktop)**: Google 문서상 "완전한 비밀 아님" 전제라 바이너리에 담김.
  다만 소스에 평문 커밋은 지양 — 기존 Claude Client ID 자리에 맞춰 처리.

### 체크리스트
```
□ 1. 프로젝트 생성 & 선택 확인
□ 2. Google Auth Platform 시작 → External로 구성
□ 3. Data Access → openid / email / profile 추가 (Gmail 제외)
□ 4. Audience → Test users 에 본인 이메일 추가
□ 5. Clients → Create client → "Desktop app" → Client ID/secret 확보
□ 6. Client ID(+secret) 확보 완료
```

---

## 3. 아키텍처 — 재사용 vs 신규

| 구성요소 | 방식 | 근거 |
|---|---|---|
| PKCE 생성 (verifier/challenge) | 기존 `oauth.rs` 로직 재사용 | Claude가 동일 방식 |
| 토큰 암호화 저장 | 기존 `secure_storage.rs` 재사용 | `google-oauth.enc` 추가 |
| 토큰 자동 갱신 | 기존 패턴 복사 | Claude의 5분 마진 갱신 |
| 브라우저 열기 | 기존 shell 플러그인 | 이미 있음 |
| 콜백 수신 (loopback 서버) | **신규** | Claude는 붙여넣기식이라 없음 |
| Google OAuth 창구 | **신규** (`google_oauth.rs`) | `oauth.rs` 본떠 엔드포인트 교체 |
| id_token 해석 → 프로필 | **신규** | 이름·사진 담을 그릇 없음 |
| 프로필 저장소 + UI | **신규** | 지금 이름·사진 개념 없음 |

핵심: 인증 골격 90% 재사용. 신규는 ①loopback 콜백 ②Google 창구 ③프로필 그릇/UI.

---

## 4. 인증 흐름 (Google 공식 엔드포인트/파라미터)

```
1. code_verifier 생성(43~128자) → code_challenge = BASE64URL(SHA256(verifier))
   state 생성 (CSRF 방지)          ← 기존 oauth.rs 로직

2. loopback 서버 기동: http://127.0.0.1:<빈 포트>   ← 신규

3. 시스템 브라우저로 열기:
   https://accounts.google.com/o/oauth2/v2/auth?
     client_id=<CLIENT_ID>
     &redirect_uri=http://127.0.0.1:<port>
     &response_type=code
     &scope=openid%20email%20profile
     &code_challenge=<challenge>
     &code_challenge_method=S256
     &state=<state>

4. 유저 승인 → Google이 127.0.0.1:<port>?code=...&state=... 로 리다이렉트
   loopback 서버가 code 수신 → state 검증 → 서버 닫고 브라우저에 "완료" 표시

5. 토큰 교환 (POST https://oauth2.googleapis.com/token):
     client_id, client_secret(desktop), code, code_verifier,
     grant_type=authorization_code, redirect_uri
   → 응답: access_token, refresh_token, id_token(JWT), expires_in, scope

6. id_token(JWT) 검증 후 디코드 → 프로필 추출:   ← 신규
     sub, email, email_verified, name, given_name, picture

7. 저장:
     토큰 → secure_storage("google-oauth.enc")   ← 기존 재사용
     프로필(name/email/picture/sub) → 프로필 저장소   ← 신규
```

- id_token 검증(Google 권장): `iss == https://accounts.google.com`, `aud == 내 client_id`,
  `exp` 미만료, 서명 검증(jwks_uri 공개키). loopback으로 직접 받은 토큰이라 중간자 위험 낮음 →
  1단계는 최소 검증(만료·aud) + 서명검증 옵션 처리도 실용적 선택.
- 갱신: 만료 시 `grant_type=refresh_token` 재발급 (Claude 갱신 로직 복사).

---

## 5. 신규 파일/모듈

**Rust (src-tauri):**
- `src/google_oauth.rs` — 위 흐름 (oauth.rs 참고)
- loopback 콜백 서버 — google_oauth.rs 내부 or `src/loopback.rs` (std TcpListener 최소 구현 가능)
- `src/profile_store.rs` — 이름·사진·이메일·sub 저장/조회
- `lib.rs` — 커맨드 등록: `start_google_oauth`, `get_google_account`, `disconnect_google`
- `Cargo.toml` — 필요 시 경량 HTTP 수신 크레이트 (또는 std TcpListener)
- `capabilities/default.json` — `accounts.google.com` 열기 허용 확인

**Frontend (src):**
- `components/auth/ConnectGoogleDialog.tsx` — 기존 다이얼로그 복사 (붙여넣기 단계 없이 자동완료)
- `hooks/useGoogleAuth.ts` — `useClaudeAuth` 미러 (`{ connected, name, email, picture }`)
- `settings/categories/ConnectionsSettings.tsx` — Google 항목 추가 (사진·이름 표시)

---

## 6. 데이터 모델 (프로필 저장소)

```
UserProfile {
  provider: "google"
  sub:      string   // Google 고유 ID (안정 식별키)
  email:    string
  name:     string
  picture:  string   // 사진 URL
  updated_at: number
}
```
- `sub`을 안정 키로 사용 (이메일은 바뀔 수 있음).
- 사진은 URL만 저장 (필요 시 나중에 캐싱).

---

## 7. 나중 Gmail 확장 지점 (지금 설계에 반영)

- Google 창구의 **스코프를 상수/파라미터로** 분리 → 나중에 `gmail.readonly` 추가가 문자열 한 줄.
- refresh token 이미 저장 → Gmail 재인증 시 같은 저장소/갱신 로직 재사용.
- 주의: 재인증 시 넓은 스코프 **전체**를 다시 요청 (설치형은 자동 병합 없음).
- 주의: Gmail 스코프는 restricted → Google 검증 + 매년 CASA 보안심사 + Privacy Policy + 도메인 필요.
  코드보다 이 심사가 크리티컬 패스이므로 그 시점에 별도 트랙으로 준비.

---

## 8. 단계별 진행 순서 + 검증 기준

```
Phase A. Google Cloud 설정
  → 검증: Client ID 발급, 동의화면에 email/profile 표시

Phase B. loopback 콜백 서버 (Rust)
  → 검증: 127.0.0.1 로 온 code 수신·로그, state 검증 동작

Phase C. Google OAuth 창구 + 토큰 교환
  → 검증: 실제 로그인 → access/refresh/id_token 수신

Phase D. id_token 디코드 + 프로필 저장
  → 검증: 이름·이메일·사진 URL이 프로필 저장소에 저장됨

Phase E. UI (다이얼로그 + 설정화면 + 훅)
  → 검증: 설정 > Connections 에서 로그인 → 사진·이름 표시, Disconnect 동작

Phase F. 토큰 자동 갱신
  → 검증: 만료 후 API 호출 시 자동 재발급
```

---

## 참고 (Sources)

- [OAuth 2.0 for Mobile & Desktop Apps (Google)](https://developers.google.com/identity/protocols/oauth2/native-app)
- [OpenID Connect (Google)](https://developers.google.com/identity/openid-connect/openid-connect)
- [Manage OAuth Clients (Google Cloud Console Help)](https://support.google.com/cloud/answer/15549257)
- [RFC 8252 - OAuth 2.0 for Native Apps](https://datatracker.ietf.org/doc/html/rfc8252)
