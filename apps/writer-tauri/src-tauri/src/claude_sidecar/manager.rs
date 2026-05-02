// Owns the chat + title sidecar processes for the lifetime of the app.
// Stored in tauri state via `app.manage(SidecarManager::new())`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::client::{NotificationHandler, SidecarClient, SidecarError};

pub struct SidecarManager {
    pub chat: Arc<SidecarClient>,
    pub title: Arc<SidecarClient>,
}

impl SidecarManager {
    pub async fn spawn_all(app: &AppHandle) -> Result<Self, SidecarError> {
        let workspace_root = find_workspace_root(app);
        let script = workspace_root
            .join("apps")
            .join("writer-tauri")
            .join("sidecar")
            .join("src")
            .join("index.mjs");
        let node = which_node().unwrap_or_else(|| PathBuf::from("node"));

        eprintln!(
            "[sidecar manager] spawning chat + title sidecars\n  node: {}\n  script: {}",
            node.display(),
            script.display(),
        );

        // Forward sidecar notifications as Tauri events so the frontend can
        // listen with `listen('claude:event', ...)` etc. The frontend gets
        // raw passthrough — the inner Agent SDK event shape is its concern.
        let app_for_handler = app.clone();
        let handler: NotificationHandler = Arc::new(move |method, params| {
            // auth/refreshNeeded is internal: the sidecar is asking the host
            // to push a fresh token. Do it asynchronously and don't surface
            // anything to the frontend — the retry will either succeed
            // silently or fail with chat/error AUTH.
            if method == "auth/refreshNeeded" {
                let app = app_for_handler.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app.try_state::<Arc<SidecarManager>>() {
                        let manager = state.inner().clone();
                        match manager.try_inject_token(&app).await {
                            Ok(true) => eprintln!("[sidecar manager] refreshed token after AUTH"),
                            Ok(false) => eprintln!("[sidecar manager] AUTH retry: no token available"),
                            Err(e) => eprintln!("[sidecar manager] AUTH retry inject failed: {e}"),
                        }
                    }
                });
                return;
            }
            let event_name = match method.as_str() {
                "chat/event" => "claude:event",
                "chat/done" => "claude:done",
                "chat/error" => "claude:error",
                "chat/proposal" => "claude:proposal",
                _ => return,
            };
            if let Err(e) = app_for_handler.emit(event_name, params) {
                eprintln!("[sidecar manager] emit {event_name} failed: {e}");
            }
        });

        let chat = SidecarClient::spawn(&node, &script, "chat", handler.clone()).await?;
        let title = SidecarClient::spawn(&node, &script, "title", handler).await?;

        // Initialize both. We don't pass any version handshake info we care
        // about yet; the response is informational.
        let _ = chat
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;
        let _ = title
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;

        eprintln!("[sidecar manager] both sidecars initialized");

        let mgr = Self {
            chat: Arc::new(chat),
            title: Arc::new(title),
        };
        // Inject the current OAuth token so the first chat doesn't pay the
        // cost of a key-chain read. Failures here are non-fatal — the user
        // may not have signed in yet; later chat calls will retry.
        match mgr.try_inject_token(app).await {
            Ok(true) => eprintln!("[sidecar manager] token injected at startup"),
            Ok(false) => eprintln!("[sidecar manager] no OAuth token yet; chat will fail until sign-in"),
            Err(e) => eprintln!("[sidecar manager] startup token inject failed: {e}"),
        }
        Ok(mgr)
    }

    /// Reads the latest OAuth token (auto-refreshing if near expiry) and
    /// pushes it to both sidecars. Returns Ok(true) if a token was injected,
    /// Ok(false) if no token is available.
    pub async fn try_inject_token(&self, app: &AppHandle) -> Result<bool, SidecarError> {
        let token = match crate::oauth::get_claude_token(app.clone()).await {
            Ok(opt) => opt,
            Err(e) => {
                eprintln!("[sidecar manager] failed to read OAuth token: {e}");
                return Ok(false);
            }
        };
        match token {
            Some(t) => {
                self.set_token(&t).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Sends `setToken` to both sidecars. Idempotent — safe to call repeatedly
    /// to rotate the OAuth token without restarting either process.
    pub async fn set_token(&self, token: &str) -> Result<(), SidecarError> {
        let params = Some(json!({ "token": token }));
        let _: Value = self.chat.request("setToken", params.clone()).await?;
        let _: Value = self.title.request("setToken", params).await?;
        Ok(())
    }
}

fn which_node() -> Option<PathBuf> {
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = Path::new(dir).join("node");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn find_workspace_root(app: &AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    for _ in 0..10 {
        // Same heuristic as the existing proof-server lookup, plus the
        // sidecar script's presence as an extra anchor.
        if dir
            .join("apps/writer-tauri/sidecar/src/index.mjs")
            .exists()
        {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else {
            break;
        }
    }
    PathBuf::from(".")
}
