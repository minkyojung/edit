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
    /// Either a single string or an array of strings (with
    /// SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel). The frontend chooses
    /// the shape; we pass it through to the SDK verbatim, which
    /// accepts both forms.
    #[serde(default)]
    pub system_prompt: Option<Value>,
    /// Names of relay tools to enable for this chat (e.g. ["propose_change"]).
    /// Sidecar handles the registration; frontend does not pass tool schemas.
    #[serde(default)]
    pub relay_tools: Option<Vec<String>>,
    /// Absolute path of the active vault folder. Forwarded to the sidecar so
    /// tools like `read_page` / `search_wiki` can read markdown directly from
    /// disk (Claude SDK-native pattern — tool handlers ARE the data source).
    /// Optional because chats without filesystem-touching tools don't need it;
    /// when omitted, the corresponding relay tools are silently disabled.
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Reasoning effort hint forwarded as-is to the SDK's `effort` option.
    /// Accepted: "low" / "medium" / "high" / "xhigh" / "max". Sidecar drops
    /// the field entirely when None, letting the SDK pick its default.
    #[serde(default)]
    pub effort: Option<String>,
    /// SDK session UUID to create with this run. Set on the first turn
    /// of a thread; the SDK persists the session under
    /// ~/.claude/projects/ so subsequent turns can resume it.
    /// Mutually exclusive with `resume`.
    #[serde(default)]
    pub session_id: Option<String>,
    /// SDK session UUID to resume. Set on every turn after the first
    /// in a thread. Loads prior conversation server-side so the
    /// frontend doesn't have to ship a transcript in the prompt.
    #[serde(default)]
    pub resume: Option<String>,
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
        params["systemPrompt"] = sp;
    }
    if let Some(tools) = args.relay_tools {
        params["relayTools"] = json!(tools);
    }
    if let Some(vp) = args.vault_path {
        params["vaultPath"] = Value::String(vp);
    }
    if let Some(mode) = args.permission_mode {
        params["permissionMode"] = Value::String(mode);
    }
    if let Some(effort) = args.effort {
        params["effort"] = Value::String(effort);
    }
    if let Some(sid) = args.session_id {
        params["sessionId"] = Value::String(sid);
    }
    if let Some(r) = args.resume {
        params["resume"] = Value::String(r);
    }

    let chat = manager.chat_client().await;
    chat.request("chat", Some(params))
        .await
        .map_err(|e| e.to_string())
}

/// Cancels an in-flight chat. Notification only — no response expected.
#[tauri::command]
pub async fn claude_chat_cancel(app: AppHandle, args: ChatCancelArgs) -> Result<(), String> {
    let manager = get_manager(&app)?;
    let chat = manager.chat_client().await;
    chat.notify("chat/cancel", Some(json!({ "runId": args.run_id })))
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

    let title = manager.title_client().await;
    title
        .request("chat", Some(params))
        .await
        .map_err(|e| e.to_string())
}
