// Anthropic API proxy from Rust backend.
//
// We can't call api.anthropic.com from the browser webview because
// Anthropic blocks browser Origins via CORS even with
// `dangerouslyAllowBrowser: true`. So all Claude calls go through here.

use crate::secure_storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

const STORAGE_NAME: &str = "claude-oauth";
const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Deserialize)]
struct StoredToken {
    access_token: String,
}

fn current_access_token(app: &AppHandle) -> Result<String, String> {
    let bytes = secure_storage::load(app, STORAGE_NAME)?
        .ok_or_else(|| "Not connected to Claude".to_string())?;
    let stored: StoredToken =
        serde_json::from_slice(&bytes).map_err(|e| format!("token parse: {e}"))?;
    Ok(stored.access_token)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ClaudeMessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[tauri::command]
pub async fn claude_messages_create(
    app: AppHandle,
    request: ClaudeMessagesRequest,
) -> Result<Value, String> {
    let token = current_access_token(&app)?;
    let resp = reqwest::Client::new()
        .post(MESSAGES_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;

    if !status.is_success() {
        return Err(format!("anthropic {status}: {body}"));
    }

    serde_json::from_str(&body).map_err(|e| format!("parse anthropic response: {e}"))
}
