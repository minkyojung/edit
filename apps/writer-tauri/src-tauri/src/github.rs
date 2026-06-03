// GitHub OAuth via Device Flow.
//
// Device Flow suits a desktop app with no loopback server (mirrors the
// shape of the Claude paste-back flow next door in oauth.rs):
//  1) frontend invokes `start_github_device_flow` → we ask GitHub for a
//     device+user code, stash the device code, return the user code +
//     verification URL for the UI to display.
//  2) user opens github.com/login/device, types the user code, authorizes.
//  3) frontend polls `poll_github_device_flow` every `interval` seconds →
//     we exchange the device code for a token; while the user hasn't
//     finished we return Pending. On success we fetch the login, persist
//     the token via secure_storage, and return Connected.
//
// GitHub OAuth-app user tokens don't expire by default, so there's no
// refresh dance — just store the access token.

use crate::secure_storage;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// Public client id from the registered GitHub OAuth App (Device Flow
// enabled). Safe to embed — it's not a secret. Device Flow uses no
// client secret.
const CLIENT_ID: &str = "Ov23liRSodZShOp6eiRC";
// read:user is enough to read the login + public activity for the first
// slice. Widening to `repo` (private activity) is a later re-auth.
const SCOPE: &str = "read:user";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_USER_URL: &str = "https://api.github.com/user";
const USER_AGENT: &str = "writer-tauri";
const STORAGE_NAME: &str = "github-oauth";

/// In-flight device flow. Holds the device code between `start` and the
/// `poll` calls that follow.
#[derive(Default)]
pub struct PendingGitHubAuth(pub Mutex<Option<PendingDevice>>);

pub struct PendingDevice {
    pub device_code: String,
}

/// Token + login persisted to secure storage.
#[derive(Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    login: String,
}

// ----- start -----

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

/// What the UI shows the user: the code to type and where to type it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[tauri::command]
pub async fn start_github_device_flow(app: AppHandle) -> Result<DeviceCodeInfo, String> {
    let resp = reqwest::Client::new()
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| format!("device code request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("device code {status}: {text}"));
    }

    let data: DeviceCodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("device code parse failed: {e}"))?;

    {
        let pending = app.state::<PendingGitHubAuth>();
        let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
        *slot = Some(PendingDevice {
            device_code: data.device_code,
        });
    }

    Ok(DeviceCodeInfo {
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval,
    })
}

// ----- poll -----

#[derive(Deserialize)]
struct TokenPollResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// Outcome of one poll. `Pending` means keep polling at the interval;
/// the others are terminal.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PollResult {
    Pending,
    Connected { login: String },
    Denied,
    Expired,
}

#[tauri::command]
pub async fn poll_github_device_flow(app: AppHandle) -> Result<PollResult, String> {
    let device_code = {
        let pending = app.state::<PendingGitHubAuth>();
        let slot = pending.0.lock().map_err(|e| e.to_string())?;
        match slot.as_ref() {
            Some(p) => p.device_code.clone(),
            None => return Err("no pending github device flow".to_string()),
        }
    };

    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("token poll failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("token poll {status}: {text}"));
    }

    // GitHub returns 200 with either an access_token or an `error` field
    // (authorization_pending / slow_down / expired_token / access_denied).
    let data: TokenPollResponse = resp
        .json()
        .await
        .map_err(|e| format!("token poll parse failed: {e}"))?;

    if let Some(token) = data.access_token {
        let login = fetch_login(&token).await?;
        let stored = StoredToken {
            access_token: token,
            login: login.clone(),
        };
        let json = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
        secure_storage::save(&app, STORAGE_NAME, &json)?;
        clear_pending(&app)?;
        return Ok(PollResult::Connected { login });
    }

    match data.error.as_deref() {
        // Still waiting on the user. slow_down is benign here because the
        // frontend already paces polls at `interval` seconds.
        Some("authorization_pending") | Some("slow_down") => Ok(PollResult::Pending),
        Some("expired_token") => {
            clear_pending(&app)?;
            Ok(PollResult::Expired)
        }
        Some("access_denied") => {
            clear_pending(&app)?;
            Ok(PollResult::Denied)
        }
        Some(other) => Err(format!("github device flow error: {other}")),
        None => Err("token poll returned neither token nor error".to_string()),
    }
}

async fn fetch_login(token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct GitHubUser {
        login: String,
    }

    let resp = reqwest::Client::new()
        .get(API_USER_URL)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("github /user failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("github /user {status}: {text}"));
    }

    let user: GitHubUser = resp
        .json()
        .await
        .map_err(|e| format!("github /user parse failed: {e}"))?;
    Ok(user.login)
}

// ----- status / disconnect -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub connected: bool,
    pub login: Option<String>,
}

fn load_token(app: &AppHandle) -> Result<Option<StoredToken>, String> {
    let bytes = match secure_storage::load(app, STORAGE_NAME)? {
        Some(b) => b,
        None => return Ok(None),
    };
    let token: StoredToken = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(Some(token))
}

#[tauri::command]
pub async fn get_github_account(app: AppHandle) -> Result<GitHubAccount, String> {
    let stored = load_token(&app)?;
    Ok(GitHubAccount {
        connected: stored.is_some(),
        login: stored.map(|s| s.login),
    })
}

/// Used by the connector slice to authorize API calls. Returns None when
/// not connected.
#[tauri::command]
pub async fn get_github_token(app: AppHandle) -> Result<Option<String>, String> {
    Ok(load_token(&app)?.map(|s| s.access_token))
}

#[tauri::command]
pub async fn disconnect_github(app: AppHandle) -> Result<(), String> {
    clear_pending(&app)?;
    secure_storage::delete(&app, STORAGE_NAME)
}

fn clear_pending(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingGitHubAuth>();
    let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    Ok(())
}
