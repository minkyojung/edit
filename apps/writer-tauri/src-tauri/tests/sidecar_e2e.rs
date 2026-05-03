// End-to-end test: Rust client <-> Node sidecar.
//
// Skipped unless CLAUDE_CODE_OAUTH_TOKEN is set in the environment, since it
// makes real network calls to Anthropic. Mirrors the 8 scenarios in
// apps/writer-tauri/sidecar/scripts/test-client.mjs.
//
// Run with:
//   export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
//   cargo test --test sidecar_e2e -- --nocapture

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::time::timeout;

use writer_tauri_lib::claude_sidecar::client::{NotificationHandler, SidecarClient};

fn sidecar_script() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .expect("apps/writer-tauri")
        .join("sidecar")
        .join("src")
        .join("index.mjs")
}

fn node_path() -> PathBuf {
    PathBuf::from("node")
}

fn require_token() -> Option<String> {
    match std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        Ok(v) if v.starts_with("sk-ant-oat") => Some(v),
        _ => {
            eprintln!("CLAUDE_CODE_OAUTH_TOKEN not set; skipping e2e test");
            None
        }
    }
}

#[derive(Default)]
struct CapturedEvents {
    text: Vec<(String, String)>, // (runId, text fragment)
    done: Vec<String>,            // runIds that finished
    errors: Vec<(String, String)>,// (runId, code)
}

fn make_handler(captured: Arc<Mutex<CapturedEvents>>) -> NotificationHandler {
    Arc::new(move |method: String, params: Value| {
        let captured = captured.clone();
        // Synchronously update via blocking lock; CapturedEvents is small.
        let mut guard = match captured.try_lock() {
            Ok(g) => g,
            Err(_) => return, // best-effort; skip rather than block
        };
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        match method.as_str() {
            "chat/event" => {
                if let Some(event) = params.get("event") {
                    if event.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                        if let Some(content) = event
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_array())
                        {
                            for block in content {
                                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                        guard.text.push((run_id.clone(), t.to_string()));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "chat/done" => guard.done.push(run_id),
            "chat/error" => {
                let code = params.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
                guard.errors.push((run_id, code));
            }
            _ => {}
        }
    })
}

async fn wait_for<F: Fn(&CapturedEvents) -> bool>(
    captured: &Arc<Mutex<CapturedEvents>>,
    pred: F,
    duration: Duration,
) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < duration {
        {
            let g = captured.lock().await;
            if pred(&g) {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chat_sidecar_full_lifecycle() {
    let Some(token) = require_token() else { return };

    let captured = Arc::new(Mutex::new(CapturedEvents::default()));
    let handler = make_handler(captured.clone());
    let client = SidecarClient::spawn(&node_path(), &sidecar_script(), "chat", handler, None)
        .await
        .expect("spawn");

    // 1. initialize
    let init = client
        .request("initialize", Some(json!({ "clientVersion": "0.0.1" })))
        .await
        .expect("initialize");
    assert_eq!(init.get("mode").and_then(|v| v.as_str()), Some("chat"));

    // 2. setToken
    client
        .request("setToken", Some(json!({ "token": token })))
        .await
        .expect("setToken");

    // 3. single chat
    let ack = client
        .request(
            "chat",
            Some(json!({
                "runId": "r1",
                "model": "claude-sonnet-4-6",
                "prompt": "Reply with exactly one word: hello"
            })),
        )
        .await
        .expect("chat r1 accepted");
    assert_eq!(ack.get("accepted").and_then(|v| v.as_bool()), Some(true));

    let ok = wait_for(
        &captured,
        |c| c.done.contains(&"r1".to_string()),
        Duration::from_secs(30),
    )
    .await;
    assert!(ok, "r1 should finish");
    let text: String = captured
        .lock()
        .await
        .text
        .iter()
        .filter(|(r, _)| r == "r1")
        .map(|(_, t)| t.clone())
        .collect();
    assert!(
        text.to_lowercase().contains("hello"),
        "expected 'hello' in r1 output, got: {text:?}"
    );

    // 4. multiplex 2 concurrent
    let _ = tokio::join!(
        client.request(
            "chat",
            Some(json!({"runId":"rA","model":"claude-sonnet-4-6","prompt":"Reply only: A"})),
        ),
        client.request(
            "chat",
            Some(json!({"runId":"rB","model":"claude-sonnet-4-6","prompt":"Reply only: B"})),
        ),
    );
    let ok = wait_for(
        &captured,
        |c| {
            c.done.contains(&"rA".to_string()) && c.done.contains(&"rB".to_string())
        },
        Duration::from_secs(30),
    )
    .await;
    assert!(ok, "rA and rB should both finish");

    // 5. cancel
    let _ = client
        .request(
            "chat",
            Some(json!({
                "runId": "rC",
                "model": "claude-sonnet-4-6",
                "prompt": "Count slowly from 1 to 30, one number per line."
            })),
        )
        .await
        .expect("rC accepted");
    tokio::time::sleep(Duration::from_millis(300)).await;
    client
        .notify("chat/cancel", Some(json!({ "runId": "rC" })))
        .await
        .expect("cancel sent");

    let ok = wait_for(
        &captured,
        |c| c.errors.iter().any(|(r, code)| r == "rC" && code == "CANCELLED"),
        Duration::from_secs(10),
    )
    .await;
    assert!(ok, "rC should be CANCELLED");

    // 6. shutdown
    timeout(
        Duration::from_secs(3),
        client.request("shutdown", Some(Value::Null)),
    )
    .await
    .expect("shutdown not stalled")
    .expect("shutdown ok");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn title_sidecar_single_flight() {
    let Some(token) = require_token() else { return };

    let captured = Arc::new(Mutex::new(CapturedEvents::default()));
    let handler = make_handler(captured.clone());
    let client = SidecarClient::spawn(&node_path(), &sidecar_script(), "title", handler, None)
        .await
        .expect("spawn");

    client
        .request("initialize", Some(json!({ "clientVersion": "0.0.1" })))
        .await
        .expect("initialize");
    client
        .request("setToken", Some(json!({ "token": token })))
        .await
        .expect("setToken");

    // Await the first chat's request — this returns once the sidecar has
    // accepted (ack = {accepted:true}). At that point the chat is registered
    // in the sidecar's active set and is producing events asynchronously, so
    // a second concurrent chat must be rejected as BUSY.
    client
        .request(
            "chat",
            Some(json!({"runId":"t1","model":"claude-haiku-4-5","prompt":"Say: hi"})),
        )
        .await
        .expect("t1 ack");

    let second = client
        .request(
            "chat",
            Some(json!({"runId":"t2","model":"claude-haiku-4-5","prompt":"Say: hi"})),
        )
        .await;
    match second {
        Err(e) => match e {
            writer_tauri_lib::claude_sidecar::client::SidecarError::Rpc { code, .. } => {
                assert_eq!(code, -32001, "expected BUSY (-32001), got {code}");
            }
            other => panic!("expected RPC error, got {other:?}"),
        },
        Ok(_) => panic!("title sidecar should have rejected second chat as BUSY"),
    }

    // Let t1 finish so shutdown is clean.
    let _ = wait_for(
        &captured,
        |c| c.done.contains(&"t1".to_string()),
        Duration::from_secs(30),
    )
    .await;

    timeout(
        Duration::from_secs(3),
        client.request("shutdown", Some(Value::Null)),
    )
    .await
    .expect("shutdown not stalled")
    .expect("shutdown ok");
}
