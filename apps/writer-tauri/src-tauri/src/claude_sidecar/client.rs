// JSON-RPC 2.0 client over a child process's stdio. Multiplexes concurrent
// requests by id, dispatches notifications via a callback. See PROTOCOL.md.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use super::framing::{encode, FrameParser};

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar exited unexpectedly")]
    Exited,
    #[error("rpc error: {code} {message}")]
    Rpc { code: i64, message: String, data: Option<Value> },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("send error")]
    Send,
}

#[derive(Serialize)]
struct Request<'a> {
    jsonrpc: &'a str,
    id: i64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a Value>,
}

#[derive(Serialize)]
struct Notification<'a> {
    jsonrpc: &'a str,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<&'a Value>,
}

#[derive(Deserialize, Debug)]
struct Incoming {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<RpcErrorPayload>,
}

#[derive(Deserialize, Debug)]
struct RpcErrorPayload {
    code: i64,
    message: String,
    data: Option<Value>,
}

/// Notification handler: receives (method, params) for every server-pushed
/// JSON-RPC notification. Spawned as a tokio task; do not block.
pub type NotificationHandler = Arc<dyn Fn(String, Value) + Send + Sync>;

/// Fires once when the sidecar's child process exits (cleanly or otherwise).
/// Used by the manager to trigger a restart.
pub type ExitHandler = Arc<dyn Fn() + Send + Sync>;

pub struct SidecarClient {
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
    write_tx: mpsc::Sender<Vec<u8>>,
    // All spawned tasks (writer, reader, stderr drain, child wait). Aborted
    // on drop so the wait task lets go of Child, which fires kill_on_drop
    // and tears the subprocess down.
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl SidecarClient {
    /// Spawns a sidecar process. `program` is the executable, `args` are
    /// passed verbatim, `extra_env` is layered on top of the inherited env
    /// (so callers don't have to mutate `std::env`).
    pub async fn spawn(
        program: &Path,
        args: &[String],
        extra_env: &[(&str, OsString)],
        on_notification: NotificationHandler,
        on_exit: Option<ExitHandler>,
    ) -> Result<Self, SidecarError> {
        let mut cmd = Command::new(program);
        for a in args {
            cmd.arg(a);
        }
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take();

        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(64);

        let mut tasks: Vec<JoinHandle<()>> = Vec::new();

        // stderr drain — log only, don't block the child if the buffer fills.
        if let Some(stderr) = stderr {
            tasks.push(tokio::spawn(drain_stderr(stderr)));
        }

        // Writer task: pulls frames off the channel and writes to child stdin.
        tasks.push(tokio::spawn(writer_loop(stdin, write_rx)));

        // Reader task: reads stdout, frames, dispatches.
        tasks.push(tokio::spawn(reader_loop(
            stdout,
            pending.clone(),
            on_notification,
        )));

        // Wait task: owns the Child. When the process exits the callback
        // fires (manager uses this to restart). When this task is aborted
        // via Drop, Child drops here and kill_on_drop tears the subprocess
        // down.
        let pending_for_exit = pending.clone();
        tasks.push(tokio::spawn(async move {
            let _ = child.wait().await;
            // Fail every still-pending request so callers don't hang.
            let mut guard = pending_for_exit.lock().await;
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(SidecarError::Exited));
            }
            drop(guard);
            if let Some(handler) = on_exit {
                handler();
            }
        }));

        Ok(Self {
            next_id: AtomicI64::new(1),
            pending,
            write_tx,
            tasks,
        })
    }

    /// Spawns the child and performs the JSON-RPC `initialize` handshake.
    /// Callers get back a client that's ready to handle real requests.
    pub async fn spawn_initialized(
        program: &Path,
        args: &[String],
        extra_env: &[(&str, OsString)],
        on_notification: NotificationHandler,
        on_exit: Option<ExitHandler>,
    ) -> Result<Self, SidecarError> {
        let client = Self::spawn(program, args, extra_env, on_notification, on_exit).await?;
        let _: Value = client
            .request("initialize", Some(json!({ "clientVersion": "0.1.0" })))
            .await?;
        Ok(client)
    }

    /// Sends a request and awaits the matching response.
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, SidecarError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = Request {
            jsonrpc: "2.0",
            id,
            method,
            params: params.as_ref(),
        };
        let payload = serde_json::to_vec(&req)?;
        let frame = encode(&payload);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        if self.write_tx.send(frame).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(SidecarError::Send);
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(SidecarError::Exited),
        }
    }

    /// Sends a notification (no response expected, no `id`).
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), SidecarError> {
        let note = Notification {
            jsonrpc: "2.0",
            method,
            params: params.as_ref(),
        };
        let payload = serde_json::to_vec(&note)?;
        let frame = encode(&payload);
        self.write_tx.send(frame).await.map_err(|_| SidecarError::Send)
    }
}

async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(frame) = rx.recv().await {
        if stdin.write_all(&frame).await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
    // Closing stdin signals EOF to the sidecar — graceful exit.
    let _ = stdin.shutdown().await;
}

async fn reader_loop(
    mut stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
    on_notification: NotificationHandler,
) {
    let mut parser = FrameParser::new();
    let mut buf = vec![0u8; 8192];

    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };
        parser.push(&buf[..n]);

        while let Some(payload) = parser.next_message() {
            let incoming: Incoming = match serde_json::from_slice(&payload) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[sidecar] failed to parse message: {e}");
                    continue;
                }
            };

            // JSON-RPC 2.0: presence of `id` distinguishes a response from a
            // notification. Don't gate on `result`/`error` — `result: null` is
            // a valid (and common) success payload, and serde treats it as
            // `None`, which would otherwise drop the response on the floor.
            if let Some(id_value) = incoming.id.as_ref() {
                let id = id_value.as_i64().unwrap_or(-1);
                let outcome = if let Some(err) = incoming.error {
                    Err(SidecarError::Rpc {
                        code: err.code,
                        message: err.message,
                        data: err.data,
                    })
                } else {
                    Ok(incoming.result.unwrap_or(Value::Null))
                };
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let _ = tx.send(outcome);
                }
                continue;
            }

            // Notification (no id, has method)
            if let Some(method) = incoming.method {
                let params = incoming.params.unwrap_or(Value::Null);
                on_notification(method, params);
            }
        }
    }

    // EOF reached — fail any still-pending requests.
    let mut guard = pending.lock().await;
    for (_, tx) in guard.drain() {
        let _ = tx.send(Err(SidecarError::Exited));
    }
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    let mut buf = vec![0u8; 4096];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]);
                eprint!("[sidecar stderr] {chunk}");
            }
            Err(_) => break,
        }
    }
}
