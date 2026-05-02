// Claude OAuth (PKCE Authorization Code + paste-back code).
//
// Flow:
//  1) frontend invokes `start_claude_oauth` → we generate PKCE + state,
//     stash them in PendingOAuth, open the system browser, return state.
//  2) user authorizes in browser, copies the displayed "AUTHCODE#STATE".
//  3) frontend invokes `complete_claude_oauth` with the pasted string;
//     we verify state, exchange code for tokens, persist via secure_storage.

use crate::secure_storage;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex as AsyncMutex;

// Refresh access tokens 5 minutes before they expire.
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;

// Serializes token reads + refreshes so concurrent callers don't
// race the refresh endpoint and invalidate each other's refresh tokens.
static REFRESH_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Token responses arrive with `expires_in` (seconds, relative). Convert to
// `expires_at` (ms epoch, absolute) at save time so all downstream checks
// can compare against `now_ms()` directly.
fn normalize_expiry(token: &mut TokenResponse) {
    if token.expires_at.is_none() {
        if let Some(secs) = token.expires_in {
            token.expires_at = Some(now_ms() + secs * 1000);
        }
    }
}

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
const SCOPE: &str = "org:create_api_key user:profile user:inference";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";

#[derive(Default)]
pub struct PendingOAuth(pub Mutex<Option<Pending>>);

pub struct Pending {
    pub verifier: String,
    pub state: String,
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill(&mut buf[..]);
    URL_SAFE_NO_PAD.encode(buf)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill(&mut buf[..]);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

#[tauri::command]
pub async fn start_claude_oauth(app: AppHandle) -> Result<(), String> {
    let verifier = random_url_safe(32);
    let state = random_hex(32);
    let challenge = pkce_challenge(&verifier);

    // JS URLSearchParams (which Claude's docs and ref implementations use)
    // encodes spaces as `+`. urlencoding crate uses `%20`. The authorize
    // server is strict — match URLSearchParams form-encoding.
    let scope_encoded = urlencoding::encode(SCOPE).replace("%20", "+");
    let url = format!(
        "{AUTHORIZE_URL}?code=true\
         &client_id={CLIENT_ID}\
         &response_type=code\
         &redirect_uri={redirect}\
         &scope={scope_encoded}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        redirect = urlencoding::encode(REDIRECT_URI),
    );

    {
        let pending = app.state::<PendingOAuth>();
        let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
        *slot = Some(Pending { verifier, state });
    }

    app.shell()
        .open(url, None)
        .map_err(|e| format!("failed to open browser: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    grant_type: &'a str,
    code: &'a str,
    state: &'a str,
    client_id: &'a str,
    redirect_uri: &'a str,
    code_verifier: &'a str,
    expires_in: u64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub account: Option<Account>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Account {
    #[serde(default)]
    pub email_address: Option<String>,
}

#[derive(Serialize)]
pub struct AccountInfo {
    pub connected: bool,
    pub email: Option<String>,
}

const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
const STORAGE_NAME: &str = "claude-oauth";

fn save_token(app: &AppHandle, token: &TokenResponse) -> Result<(), String> {
    let json = serde_json::to_vec(token).map_err(|e| e.to_string())?;
    secure_storage::save(app, STORAGE_NAME, &json)
}

fn load_token(app: &AppHandle) -> Result<Option<TokenResponse>, String> {
    let bytes = match secure_storage::load(app, STORAGE_NAME)? {
        Some(b) => b,
        None => return Ok(None),
    };
    let token: TokenResponse = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(token))
}

#[tauri::command]
pub async fn complete_claude_oauth(
    app: AppHandle,
    pasted: String,
    pending: State<'_, PendingOAuth>,
) -> Result<(), String> {
    let (code, state_from_paste) = pasted
        .split_once('#')
        .ok_or_else(|| "Expected format: AUTHCODE#STATE".to_string())?;

    let stash = {
        let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
        slot.take().ok_or_else(|| "No pending OAuth flow".to_string())?
    };

    if stash.state != state_from_paste {
        return Err("state mismatch — possible CSRF, restart sign-in".to_string());
    }

    let body = TokenRequest {
        grant_type: "authorization_code",
        code: code.trim(),
        state: state_from_paste,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: &stash.verifier,
        expires_in: 31_536_000,
    };

    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange {status}: {text}"));
    }

    let mut token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token response parse failed: {e}"))?;

    normalize_expiry(&mut token);
    save_token(&app, &token)?;
    Ok(())
}

#[derive(Serialize)]
struct RefreshRequest<'a> {
    grant_type: &'a str,
    refresh_token: &'a str,
    client_id: &'a str,
}

async fn do_refresh(app: &AppHandle, refresh_token: &str) -> Result<TokenResponse, String> {
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&RefreshRequest {
            grant_type: "refresh_token",
            refresh_token,
            client_id: CLIENT_ID,
        })
        .send()
        .await
        .map_err(|e| format!("refresh request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("refresh {status}: {text}"));
    }

    let mut token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("refresh response parse failed: {e}"))?;

    // Some servers don't rotate refresh tokens — keep the previous one in that case.
    if token.refresh_token.is_none() {
        token.refresh_token = Some(refresh_token.to_string());
    }
    normalize_expiry(&mut token);
    save_token(app, &token)?;
    Ok(token)
}

#[tauri::command]
pub async fn get_claude_token(app: AppHandle) -> Result<Option<String>, String> {
    // Serialize concurrent callers: the first acquires, refreshes if needed,
    // and writes the new token to disk; subsequent callers re-load that
    // already-fresh token instead of refreshing again.
    let _guard = REFRESH_LOCK.lock().await;

    let Some(token) = load_token(&app)? else {
        return Ok(None);
    };

    // If expires_at is missing (e.g. token saved by an older app version), we
    // can't tell how stale it is — refresh once to populate the field, then
    // subsequent calls follow the normal margin-based path.
    let needs_refresh = match token.expires_at {
        Some(exp) => now_ms() > exp - REFRESH_MARGIN_MS,
        None => true,
    };

    if !needs_refresh {
        return Ok(Some(token.access_token));
    }

    let Some(refresh_token) = token.refresh_token.as_deref() else {
        // Can't refresh without a refresh_token — clear and force re-login.
        let _ = secure_storage::delete(&app, STORAGE_NAME);
        return Ok(None);
    };

    match do_refresh(&app, refresh_token).await {
        Ok(new_token) => Ok(Some(new_token.access_token)),
        Err(e) => {
            eprintln!("[oauth] refresh failed: {e}");
            let _ = secure_storage::delete(&app, STORAGE_NAME);
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn get_claude_account(app: AppHandle) -> Result<AccountInfo, String> {
    let token = load_token(&app)?;
    Ok(AccountInfo {
        connected: token.is_some(),
        email: token.and_then(|t| t.account.and_then(|a| a.email_address)),
    })
}

#[tauri::command]
pub async fn disconnect_claude(app: AppHandle) -> Result<(), String> {
    secure_storage::delete(&app, STORAGE_NAME)
}
