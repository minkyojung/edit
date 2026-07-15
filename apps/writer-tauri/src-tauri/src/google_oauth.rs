// Google OAuth (PKCE Authorization Code + loopback auto-complete).
//
// Unlike Claude's paste-back flow (oauth.rs), Google runs a one-shot loopback
// callback: we spin up a throwaway 127.0.0.1 server, open the browser, and the
// browser redirects the code straight back to us — no copy/paste. One command
// (`start_google_oauth`) drives the whole thing and resolves when done.
//
// Purpose: collect the user's identity (name / email / picture). The token blob
// carries the profile alongside the tokens (mirrors how oauth.rs stores
// `account`), so no separate profile store is needed. Scope is kept minimal
// (`openid email profile`); Gmail is a future, heavier re-consent (see
// docs/google-login-plan.md §7).

use crate::secure_storage;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex as AsyncMutex;

// Credentials are baked into the binary at compile time from gitignored files
// (see secrets/README.md) — kept out of git so they never land in history
// (GitHub push protection blocks them, and history is hard to purge later). For
// a Desktop app neither value is truly confidential (RFC 8252): PKCE protects
// the flow, not the secret; the files just keep them out of the committed source.
// A missing file is a loud compile error by design (include_str!).
fn client_id() -> &'static str {
    include_str!("../secrets/google_client_id").trim()
}
fn client_secret() -> &'static str {
    include_str!("../secrets/google_client_secret").trim()
}

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";
// Cloudflare Worker that relays the sign-up to Loops (holds the Loops key). It
// re-verifies the Google token itself, so we just forward the access token.
const SIGNUP_RELAY_URL: &str = "https://loops-relay.flowcap.workers.dev";
const SCOPE: &str = "openid email profile";
const STORAGE_NAME: &str = "google-oauth";

// Refresh access tokens 5 minutes before they expire.
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
// How long to keep the loopback server open waiting for the user to authorize.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

// Serializes token reads + refreshes so concurrent callers don't race the
// refresh endpoint and invalidate each other's refresh tokens.
static REFRESH_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

// ── Stored shapes ───────────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct GoogleProfile {
    pub sub: String,     // stable Google user id (email can change)
    pub email: String,
    pub name: String,
    pub picture: String, // photo URL
}

// What we persist (encrypted) to secure_storage. Profile rides along with the
// tokens, exactly like oauth.rs's `account`.
#[derive(Deserialize, Serialize, Debug)]
struct StoredGoogle {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
    profile: GoogleProfile,
}

// What the frontend sees.
#[derive(Serialize)]
pub struct GoogleAccount {
    pub connected: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub picture: Option<String>,
}

impl GoogleAccount {
    fn disconnected() -> Self {
        Self { connected: false, email: None, name: None, picture: None }
    }
    fn from_profile(p: &GoogleProfile) -> Self {
        Self {
            connected: true,
            email: Some(p.email.clone()),
            name: Some(p.name.clone()),
            picture: Some(p.picture.clone()),
        }
    }
}

fn save_stored(app: &AppHandle, stored: &StoredGoogle) -> Result<(), String> {
    let json = serde_json::to_vec(stored).map_err(|e| e.to_string())?;
    secure_storage::save(app, STORAGE_NAME, &json)
}

fn load_stored(app: &AppHandle) -> Result<Option<StoredGoogle>, String> {
    let bytes = match secure_storage::load(app, STORAGE_NAME)? {
        Some(b) => b,
        None => return Ok(None),
    };
    let stored: StoredGoogle = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(stored))
}

// ── Token / userinfo wire shapes ────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

// ── The loopback callback server ────────────────────────────────────────────

// Blocks (with a deadline) until the browser hits our loopback port with the
// authorization code. Returns the code once state matches. Runs on a blocking
// thread (spawn_blocking) — it polls the non-blocking listener so it can honor
// the timeout instead of hanging forever if the user closes the browser.
fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("loopback setup failed: {e}"))?;
    let deadline = Instant::now() + CALLBACK_TIMEOUT;

    loop {
        if Instant::now() > deadline {
            return Err("sign-in timed out — please try again".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                // Back to blocking with a short read timeout for this one client.
                stream.set_nonblocking(false).ok();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .ok();

                let mut request_line = String::new();
                BufReader::new(&stream).read_line(&mut request_line).ok();

                // Request line: `GET /?code=...&state=... HTTP/1.1`
                let target = request_line.split_whitespace().nth(1).unwrap_or("");
                let params = parse_query(target);

                if let Some(err) = params_get(&params, "error") {
                    respond(&mut stream, "Sign-in cancelled. You can close this window.");
                    return Err(format!("authorization denied: {err}"));
                }

                match params_get(&params, "code") {
                    Some(code) => {
                        let state = params_get(&params, "state").unwrap_or_default();
                        if state != expected_state {
                            respond(&mut stream, "Sign-in failed (state mismatch).");
                            return Err("state mismatch — possible CSRF, restart sign-in".to_string());
                        }
                        respond(
                            &mut stream,
                            "Signed in to Octave. You can close this window and return to the app.",
                        );
                        return Ok(code);
                    }
                    // Stray request (e.g. favicon) — answer and keep waiting.
                    None => {
                        respond(&mut stream, "Waiting for sign-in…");
                        continue;
                    }
                }
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("loopback accept failed: {e}")),
        }
    }
}

fn respond(stream: &mut std::net::TcpStream, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <title>Octave</title></head>\
         <body style=\"font-family:-apple-system,system-ui,sans-serif;\
         display:flex;align-items:center;justify-content:center;height:100vh;\
         margin:0;color:#222\"><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

// Minimal `key=value&key=value` query parser with percent-decoding.
fn parse_query(target: &str) -> Vec<(String, String)> {
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((k.to_string(), percent_decode(v)))
        })
        .collect()
}

fn params_get(params: &[(String, String)], key: &str) -> Option<String> {
    params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.replace('+', " ");
    let bytes = bytes.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Parse the two hex digits from the byte slice, not the &str:
            // slicing `input[i + 1..i + 3]` by byte offsets panics when a
            // literal '%' is followed by a multi-byte UTF-8 char (the range
            // would fall inside a char boundary).
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ── The flow ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_google_oauth(app: AppHandle) -> Result<GoogleAccount, String> {
    let verifier = random_url_safe(32);
    let state = random_hex(32);
    let challenge = pkce_challenge(&verifier);

    // Bind a throwaway loopback port (OS picks a free one).
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to open loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let url = format!(
        "{AUTHORIZE_URL}?client_id={client_id}\
         &redirect_uri={redirect}\
         &response_type=code\
         &scope={scope}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        client_id = urlencoding::encode(client_id()),
        redirect = urlencoding::encode(&redirect_uri),
        scope = urlencoding::encode(SCOPE),
    );

    app.shell()
        .open(url, None)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    // Wait for the redirect on a blocking thread so the timeout is honored.
    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_callback(listener, &expected_state))
        .await
        .map_err(|e| format!("callback task failed: {e}"))??;

    // Exchange the code for tokens (Google's token endpoint wants form-encoding,
    // not JSON — this differs from Claude's oauth.rs).
    let token = exchange_code(&code, &verifier, &redirect_uri).await?;
    let profile = fetch_profile(&token.access_token).await?;

    let stored = StoredGoogle {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_in.map(|s| now_ms() + s * 1000),
        profile: profile.clone(),
    };
    save_stored(&app, &stored)?;

    Ok(GoogleAccount::from_profile(&profile))
}

async fn exchange_code(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(&[
            ("code", code),
            ("client_id", client_id()),
            ("client_secret", client_secret()),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("token exchange {status}: {text}"));
    }
    resp.json()
        .await
        .map_err(|e| format!("token response parse failed: {e}"))
}

async fn fetch_profile(access_token: &str) -> Result<GoogleProfile, String> {
    let resp = reqwest::Client::new()
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("userinfo request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("userinfo {status}: {text}"));
    }
    resp.json::<GoogleProfile>()
        .await
        .map_err(|e| format!("userinfo parse failed: {e}"))
}

// Tell the Loops relay a user just signed up (so the welcome email goes out).
// Called once from onboarding after a successful Google sign-in — NOT from the
// settings reconnect path, so re-connecting never re-sends the welcome. Sends
// the stored access token (the relay re-verifies it with Google) + display name.
// Best-effort: the caller fires this and ignores the result, so a relay outage
// never blocks or breaks onboarding.
#[tauri::command]
pub async fn notify_signup(app: AppHandle) -> Result<(), String> {
    let Some(stored) = load_stored(&app)? else {
        return Ok(()); // not signed in — nothing to relay
    };
    let resp = reqwest::Client::new()
        .post(SIGNUP_RELAY_URL)
        .json(&serde_json::json!({
            "token": stored.access_token,
            "name": stored.profile.name,
        }))
        .send()
        .await
        .map_err(|e| format!("signup relay request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("signup relay {status}: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_google_account(app: AppHandle) -> Result<GoogleAccount, String> {
    match load_stored(&app)? {
        Some(stored) => Ok(GoogleAccount::from_profile(&stored.profile)),
        None => Ok(GoogleAccount::disconnected()),
    }
}

#[tauri::command]
pub async fn disconnect_google(app: AppHandle) -> Result<(), String> {
    secure_storage::delete(&app, STORAGE_NAME)
}

// Returns a valid access token, refreshing if within the expiry margin. Not
// used for the identity display (that reads the stored profile), but kept for
// the future Gmail scope so callers get auto-refreshed tokens for free.
#[tauri::command]
pub async fn get_google_token(app: AppHandle) -> Result<Option<String>, String> {
    let _guard = REFRESH_LOCK.lock().await;

    let Some(stored) = load_stored(&app)? else {
        return Ok(None);
    };

    let needs_refresh = match stored.expires_at {
        Some(exp) => now_ms() > exp - REFRESH_MARGIN_MS,
        None => true,
    };
    if !needs_refresh {
        return Ok(Some(stored.access_token));
    }

    let Some(refresh_token) = stored.refresh_token.as_deref() else {
        // No refresh token — the stored access token is all we have.
        return Ok(Some(stored.access_token));
    };

    match do_refresh(&app, refresh_token, &stored.profile).await {
        Ok(access_token) => Ok(Some(access_token)),
        Err(e) => {
            eprintln!("[google_oauth] refresh failed: {e}");
            Ok(Some(stored.access_token))
        }
    }
}

async fn do_refresh(
    app: &AppHandle,
    refresh_token: &str,
    profile: &GoogleProfile,
) -> Result<String, String> {
    // Bounded timeouts are load-bearing here: do_refresh runs while holding
    // REFRESH_LOCK, so a POST that connects but never responds (flaky network)
    // would block EVERY get_google_token caller with no error path. On timeout
    // we fail out and fall back to the stored token. reqwest defaults to none.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("refresh client build failed: {e}"))?;
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id()),
            ("client_secret", client_secret()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("refresh request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("refresh {status}: {text}"));
    }
    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("refresh response parse failed: {e}"))?;

    let stored = StoredGoogle {
        access_token: token.access_token.clone(),
        // Google doesn't rotate refresh tokens on refresh — keep the old one.
        refresh_token: Some(refresh_token.to_string()),
        expires_at: token.expires_in.map(|s| now_ms() + s * 1000),
        profile: profile.clone(),
    };
    save_stored(app, &stored)?;
    Ok(token.access_token)
}
