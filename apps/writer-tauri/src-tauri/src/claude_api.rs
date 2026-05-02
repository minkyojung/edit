// Anthropic API proxy from Rust backend.
//
// Why we proxy:
// 1. CORS — api.anthropic.com blocks browser Origins.
// 2. Token security — OAuth token stays in Rust keychain, never reaches JS.
//
// `claude_proxy` is a generalized streaming proxy used by the JS Anthropic
// SDK via a custom fetch adapter (see lib/tauriFetch.ts). The frontend
// passes a channelId; status / chunk / done / error are emitted as Tauri
// events keyed by that id, so the adapter can rebuild a Response with a
// streaming body.

use crate::secure_storage;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

const STORAGE_NAME: &str = "claude-oauth";
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

#[derive(Default)]
pub struct ProxyAborts(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub channel_id: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Serialize, Clone)]
struct StatusEvent {
    status: u16,
    headers: HashMap<String, String>,
}

#[derive(Serialize, Clone)]
struct ErrorEvent {
    message: String,
}

#[tauri::command]
pub async fn claude_proxy(app: AppHandle, request: ProxyRequest) -> Result<(), String> {
    let token = current_access_token(&app)?;
    let ProxyRequest {
        channel_id,
        url,
        method,
        headers,
        body,
    } = request;

    // Register an abort handle keyed by channel_id so claude_cancel can find it.
    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    {
        let aborts = app.state::<ProxyAborts>();
        aborts
            .0
            .lock()
            .map_err(|e| format!("abort lock: {e}"))?
            .insert(channel_id.clone(), abort_tx);
    }

    let method_parsed: reqwest::Method = method
        .parse()
        .map_err(|e| format!("invalid method: {e}"))?;
    let mut req_builder = reqwest::Client::new().request(method_parsed, &url);

    // Headers we control — never let the SDK override these.
    req_builder = req_builder
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", OAUTH_BETA);

    for (k, v) in &headers {
        let lower = k.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "authorization"
                | "anthropic-version"
                | "anthropic-beta"
                | "host"
                | "content-length"
                | "x-api-key"
        ) {
            continue;
        }
        req_builder = req_builder.header(k, v);
    }

    if let Some(b) = body {
        // Frontend always serializes JSON; SDK doesn't ship binary bodies.
        req_builder = req_builder
            .header("content-type", "application/json")
            .body(b);
    }

    let app_for_task = app.clone();
    let cid = channel_id.clone();

    tauri::async_runtime::spawn(async move {
        run_proxy_task(app_for_task, cid, req_builder, abort_rx).await;
    });

    Ok(())
}

async fn run_proxy_task(
    app: AppHandle,
    channel_id: String,
    req_builder: reqwest::RequestBuilder,
    mut abort_rx: oneshot::Receiver<()>,
) {
    let status_evt = format!("claude_proxy:status:{channel_id}");
    let chunk_evt = format!("claude_proxy:chunk:{channel_id}");
    let done_evt = format!("claude_proxy:done:{channel_id}");
    let error_evt = format!("claude_proxy:error:{channel_id}");

    // Cleanup the abort registration whenever we leave this task.
    let cleanup = || {
        if let Some(state) = app.try_state::<ProxyAborts>() {
            if let Ok(mut m) = state.0.lock() {
                m.remove(&channel_id);
            }
        }
    };

    let resp = tokio::select! {
        r = req_builder.send() => r,
        _ = &mut abort_rx => {
            let _ = app.emit(&error_evt, ErrorEvent { message: "aborted".into() });
            cleanup();
            return;
        }
    };

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit(
                &error_evt,
                ErrorEvent {
                    message: format!("request failed: {e}"),
                },
            );
            cleanup();
            return;
        }
    };

    let status = resp.status().as_u16();
    let mut header_map = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            header_map.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let _ = app.emit(
        &status_evt,
        StatusEvent {
            status,
            headers: header_map,
        },
    );

    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            next = stream.next() => {
                match next {
                    Some(Ok(bytes)) => {
                        let _ = app.emit(&chunk_evt, bytes.to_vec());
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(
                            &error_evt,
                            ErrorEvent { message: format!("stream error: {e}") },
                        );
                        break;
                    }
                    None => {
                        let _ = app.emit::<()>(&done_evt, ());
                        break;
                    }
                }
            }
            _ = &mut abort_rx => {
                let _ = app.emit(&error_evt, ErrorEvent { message: "aborted".into() });
                break;
            }
        }
    }

    cleanup();
}

#[tauri::command]
pub fn claude_cancel(aborts: State<'_, ProxyAborts>, channel_id: String) -> Result<(), String> {
    let mut map = aborts.0.lock().map_err(|e| format!("abort lock: {e}"))?;
    if let Some(tx) = map.remove(&channel_id) {
        let _ = tx.send(());
    }
    Ok(())
}
