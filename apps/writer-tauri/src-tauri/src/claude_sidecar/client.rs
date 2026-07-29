// JSON-RPC 2.0 client over a child process's stdio. Multiplexes concurrent
// requests by id, dispatches notifications via a callback. See PROTOCOL.md.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use super::framing::{encode, FrameParser};

/// Wire-protocol contract version. Bump in lockstep with the sidecar's
/// `PROTOCOL_VERSION` (sidecar/src/server.mjs) on any breaking change to the
/// request/notification shapes in PROTOCOL.md. Asserted during `initialize`:
/// a mismatch means the bundled sidecar is stale (typically `pnpm pack:sidecar`
/// wasn't re-run) and we refuse to run it rather than misbehave silently.
pub const PROTOCOL_VERSION: u32 = 1;

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
    #[error(
        "sidecar protocol version mismatch: app expects {expected}, sidecar reports {got:?} \
         — the bundled sidecar is stale; re-run `pnpm pack:sidecar`"
    )]
    ProtocolMismatch { expected: u32, got: Option<u32> },
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
    // Child pid, which is also its process-group id (we spawn it as a group
    // leader). Lets `hard_kill` SIGKILL the whole group — the Node process AND
    // its `claude` CLI grandchild — as a backstop when graceful shutdown is
    // too slow or the sidecar hangs. None only if the OS didn't report a pid.
    pid: Option<u32>,
    // Set once the process group is either deliberately killed or reaped by
    // the wait task, whichever happens first. Guards two things at once:
    //
    //   - the exit handler, so a teardown we asked for is never reported to
    //     the manager as a crash (which would have it respawn what we just
    //     killed, and count that against the crash-loop budget);
    //   - `hard_kill`, so we never signal a pgid whose leader has already
    //     been reaped and whose pid the OS may have handed to someone else.
    disarmed: Arc<AtomicBool>,
    // All spawned tasks (writer, reader, stderr drain, child wait). Aborted
    // on drop, which lets the wait task release Child.
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for SidecarClient {
    fn drop(&mut self) {
        // Order matters: abort first so the wait task cannot observe the kill
        // and report it as a crash, then take the group down.
        for task in &self.tasks {
            task.abort();
        }
        // `kill_on_drop` alone reaps only the direct child, leaving the
        // `claude` CLI grandchild orphaned — one per restart, and the dev
        // watcher restarts on every sidecar source edit.
        self.hard_kill();
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
        // Put the sidecar in its own process group (leader pid == child pid) so
        // `hard_kill` can SIGKILL the whole group and take the `claude` CLI
        // grandchild with it. `kill_on_drop` only reaps the direct child, which
        // is exactly why the grandchild could otherwise be orphaned.
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn()?;
        let pid = child.id();
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

        // Wait task: owns the Child. An exit we didn't ask for fires the
        // callback, which is how the manager learns to restart. One we did
        // ask for is swallowed — see `disarmed`.
        let pending_for_exit = pending.clone();
        let disarmed = Arc::new(AtomicBool::new(false));
        let disarmed_for_exit = disarmed.clone();
        tasks.push(tokio::spawn(async move {
            let _ = child.wait().await;
            // Fail every still-pending request so callers don't hang. This
            // happens regardless of why the process went away.
            let mut guard = pending_for_exit.lock().await;
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err(SidecarError::Exited));
            }
            drop(guard);
            // The pid is reaped now, so a later `hard_kill` must not signal it.
            // If the flag was already set the exit was ours, not a crash — stay
            // quiet rather than have the manager restart a sidecar we retired.
            if !disarmed_for_exit.swap(true, Ordering::SeqCst) {
                if let Some(handler) = on_exit {
                    handler();
                }
            }
        }));

        Ok(Self {
            next_id: AtomicI64::new(1),
            pending,
            write_tx,
            pid,
            disarmed,
            tasks,
        })
    }

    /// SIGKILL the sidecar's entire process group (the Node process and its
    /// `claude` CLI grandchild). Used on drop and as the app-quit backstop:
    /// after we've asked the sidecar to leave gracefully and waited a bounded
    /// grace, this guarantees nothing survives — even a hung sidecar or a CLI
    /// child the graceful path didn't reap in time.
    ///
    /// Idempotent, and deliberately silent: the resulting exit is never
    /// reported through the exit handler, so callers can retire a client
    /// without the manager mistaking it for a crash and restarting it.
    pub fn hard_kill(&self) {
        // Already killed, or already reaped by the wait task — in the latter
        // case the pid may since have been recycled, so signalling it would be
        // worse than a no-op.
        if self.disarmed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // Negative pid targets the whole process group (see setpgid(2)).
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
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
        let init: Value = client
            .request(
                "initialize",
                Some(json!({ "clientVersion": "0.1.0", "protocolVersion": PROTOCOL_VERSION })),
            )
            .await?;
        // Assert-equal on the wire-protocol version. Client and sidecar ship in
        // the same app bundle, so a mismatch is never a compatibility spread to
        // negotiate — it's a packaging bug (stale sidecar-pkg). Fail loudly.
        let got = init
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .map(|v| v as u32);
        if got != Some(PROTOCOL_VERSION) {
            return Err(SidecarError::ProtocolMismatch { expected: PROTOCOL_VERSION, got });
        }
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
