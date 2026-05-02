// Tauri commands invoked from the frontend.
//
// Streaming output flows back as Tauri events:
//   - "claude:event" for each Agent SDK event
//   - "claude:done"  on successful completion
//   - "claude:error" on failure or cancellation
// Each event payload carries a `runId` to identify which chat it belongs to.

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::manager::SidecarManager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartArgs {
    pub run_id: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Option<Value>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCancelArgs {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleArgs {
    pub run_id: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

fn get_manager(app: &AppHandle) -> Result<Arc<SidecarManager>, String> {
    let state = app
        .try_state::<Arc<SidecarManager>>()
        .ok_or_else(|| "Claude sidecars not yet ready".to_string())?;
    Ok(state.inner().clone())
}

/// Starts a chat on the chat sidecar. Returns the immediate ack
/// (`{ runId, accepted }`); subsequent streaming output arrives as events.
#[tauri::command]
pub async fn claude_chat_start(app: AppHandle, args: ChatStartArgs) -> Result<Value, String> {
    let manager = get_manager(&app)?;
    // Push the freshest token before every chat — handles silent rotation
    // without requiring a sidecar restart.
    manager
        .try_inject_token(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut params = json!({
        "runId": args.run_id,
        "model": args.model,
        "prompt": args.prompt,
    });
    if let Some(sp) = args.system_prompt {
        params["systemPrompt"] = Value::String(sp);
    }
    if let Some(tools) = args.tools {
        params["tools"] = tools;
    }
    if let Some(mode) = args.permission_mode {
        params["permissionMode"] = Value::String(mode);
    }

    manager
        .chat
        .request("chat", Some(params))
        .await
        .map_err(|e| e.to_string())
}

/// Cancels an in-flight chat. Notification only — no response expected.
#[tauri::command]
pub async fn claude_chat_cancel(app: AppHandle, args: ChatCancelArgs) -> Result<(), String> {
    let manager = get_manager(&app)?;
    manager
        .chat
        .notify("chat/cancel", Some(json!({ "runId": args.run_id })))
        .await
        .map_err(|e| e.to_string())
}

/// Runs a single-shot chat on the title sidecar. Used for thread-title
/// generation. Returns the same ack shape as `claude_chat_start`; events
/// flow on the same `claude:*` channel.
#[tauri::command]
pub async fn claude_title(app: AppHandle, args: TitleArgs) -> Result<Value, String> {
    let manager = get_manager(&app)?;
    manager
        .try_inject_token(&app)
        .await
        .map_err(|e| e.to_string())?;

    let mut params = json!({
        "runId": args.run_id,
        "model": args.model,
        "prompt": args.prompt,
    });
    if let Some(sp) = args.system_prompt {
        params["systemPrompt"] = Value::String(sp);
    }

    manager
        .title
        .request("chat", Some(params))
        .await
        .map_err(|e| e.to_string())
}
