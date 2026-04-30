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
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

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

    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("token response parse failed: {e}"))?;

    save_token(&app, &token)?;
    Ok(())
}

#[tauri::command]
pub async fn get_claude_token(app: AppHandle) -> Result<Option<String>, String> {
    Ok(load_token(&app)?.map(|t| t.access_token))
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
