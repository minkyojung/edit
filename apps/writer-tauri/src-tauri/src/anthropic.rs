//! Tauri command `anthropic_messages_create` — POSTs a Messages API
//! request to api.anthropic.com from Rust (server-side), bypassing
//! the browser CORS policy that blocks direct WebView calls.
//!
//! Why this exists: profile extraction needs the `tool_choice` API
//! feature to force the model into `submit_profile`, but the Claude
//! Agent SDK we use elsewhere (chat, ingest) doesn't expose that
//! option. The honest fix is a direct Messages API call. Browsers
//! can't make that call (Anthropic blocks the preflight); Rust can.
//!
//! Auth: pulls the OAuth access token from secure storage via the
//! same `oauth::get_claude_token` path the sidecar uses, so the user
//! doesn't re-authenticate. The `anthropic-beta: oauth-2025-04-20`
//! header is required for OAuth-token auth (Claude Code's flow).

use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::oauth;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const TIMEOUT_SECS: u64 = 60;

#[derive(Deserialize)]
pub struct AnthropicRequest {
    /// Full Messages API JSON body. We pass it through verbatim so
    /// the frontend can use any current/future API field (system,
    /// messages, tools, tool_choice, etc.) without us having to
    /// keep the schema in sync on the Rust side.
    body: Value,
}

#[derive(serde::Serialize)]
pub struct AnthropicResponse {
    status: u16,
    /// Raw response body parsed as JSON. The frontend extracts the
    /// `content` blocks (text / tool_use) it cares about.
    body: Value,
}

#[tauri::command]
pub async fn anthropic_messages_create(
    app: AppHandle,
    request: AnthropicRequest,
) -> Result<AnthropicResponse, String> {
    let token = oauth::get_claude_token(app.clone())
        .await
        .map_err(|e| format!("token fetch: {e}"))?
        .ok_or_else(|| "no claude token — user must sign in".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("client init: {e}"))?;

    let resp = client
        .post(ANTHROPIC_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01")
        // Required by Anthropic's OAuth-token auth path (sk-ant-oat-*).
        // Without it the API returns 401 even with a valid token.
        .header("anthropic-beta", "oauth-2025-04-20")
        .json(&request.body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp
        .json::<Value>()
        .await
        .map_err(|e| format!("response decode: {e}"))?;

    Ok(AnthropicResponse { status, body })
}
