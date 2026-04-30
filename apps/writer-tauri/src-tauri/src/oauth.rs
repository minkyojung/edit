// Claude OAuth (PKCE Authorization Code + paste-back code).
//
// Flow:
//  1) frontend invokes `start_claude_oauth` → we generate PKCE + state,
//     stash them in PendingOAuth, open the system browser, return state.
//  2) user authorizes in browser, copies the displayed "AUTHCODE#STATE".
//  3) frontend invokes `complete_claude_oauth` with the pasted string;
//     we verify state, exchange code for tokens, persist via keyring (TODO).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
const SCOPE: &str = "user:inference";
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

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

#[tauri::command]
pub async fn start_claude_oauth(app: AppHandle) -> Result<(), String> {
    let verifier = random_url_safe(32);
    let state = random_url_safe(16);
    let challenge = pkce_challenge(&verifier);

    let url = format!(
        "{AUTHORIZE_URL}?code=true\
         &client_id={CLIENT_ID}\
         &response_type=code\
         &redirect_uri={redirect}\
         &scope={scope}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        redirect = urlencoding::encode(REDIRECT_URI),
        scope = urlencoding::encode(SCOPE),
    );
    println!("[oauth] authorize URL: {url}");

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

#[derive(Deserialize, Debug)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub expires_in: Option<i64>,
}

#[tauri::command]
pub async fn complete_claude_oauth(
    app: AppHandle,
    pasted: String,
    pending: State<'_, PendingOAuth>,
) -> Result<(), String> {
    let _ = app; // reserved for keyring integration in next step

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

    // Token exchange via reqwest is added in the next step, alongside keyring storage.
    // For now, return a clear stub error so the call site can surface progress.
    let _ = body;
    Err("Token exchange not yet implemented (next step).".to_string())
}
