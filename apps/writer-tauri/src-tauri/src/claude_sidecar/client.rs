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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use super::framing::{encode, FrameParser};

/// Wire-protocol contract version. Bump in lockstep with the sidecar's
/// `PROTOCOL_VERSION` (sidecar/src/server.mjs) on any breaking change to the
/// request/notification shapes in PROTOCOL.md. Asserted during `initialize`:
/// a mismatch means the bundled sidecar is stale (typically `pnpm pack:sidecar`
/// wasn't re-run) and we refuse to run it rather than misbehave silently.
pub const PROTOCOL_VERSION: u32 = 1;

/// JSON-RPC 2.0 reserved code. Mirrors `METHOD_NOT_FOUND` in
/// sidecar/src/jsonrpc.mjs, which already owns the constant on the far side.
const METHOD_NOT_FOUND: i64 = -32601;
const INTERNAL_ERROR: i64 = -32603;

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

#[derive(Serialize)]
struct Response<'a> {
    jsonrpc: &'a str,
    id: &'a Value,
    // Deliberately NOT skip_serializing_if: `result: null` is a valid success
    // payload, and a response carrying neither `result` nor `error` is
    // malformed. Mirror of the read-side note on classification.
    result: &'a Value,
}

/// Reply to an inbound request. The id is echoed as the raw `Value` it arrived
/// as — ids may be strings, and answering `id: "abc"` with `id: -1` is a reply
/// to a request nobody made.
#[derive(Serialize)]
struct ErrorResponse<'a> {
    jsonrpc: &'a str,
    // Echoed byte-for-byte as the raw Value the peer sent. JSON-RPC ids may be
    // strings as well as numbers, and answering `id: "abc"` with `id: -1` — the
    // `as_i64().unwrap_or(-1)` shape used on the read path — is a reply to a
    // request that doesn't exist, which is worse than the drop it replaces.
    id: &'a Value,
    error: RpcError<'a>,
}

#[derive(Serialize)]
struct RpcError<'a> {
    code: i64,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a Value>,
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

/// Serves one inbound JSON-RPC request. Receives (method, params, responder).
///
/// MUST NOT block or await: it runs on the reader task, which is the only
/// thing draining the peer's stdout — stalling here stalls every inbound
/// frame, including the answer to anything the handler itself is waiting on.
/// Move the `Responder` into a spawned task and answer from there.
///
/// Built per client rather than shared, mirroring `build_exit`: the responder
/// carries the write channel of the client that received the request, so a
/// reply can never land on the wrong sidecar — including after a restart has
/// swapped the `Arc` underneath.
pub type RequestHandler = Arc<dyn Fn(String, Value, Responder) + Send + Sync>;

/// Reply handle for exactly one inbound request.
///
/// Both halves of "exactly one" are structural:
///   - at most once — `ok`/`err` take the id, and the id is the only send
///     token. There is no second id, so there is no second send. A `bool`
///     alongside the id could drift; taking the id makes the flag and the
///     payload the same object.
///   - at least once — `Drop` answers if the token is still there, so a
///     handler that panics, early-returns or forgets cannot leave the peer
///     waiting forever. (The ACP Rust SDK's responder sends nothing on drop
///     for non-batch requests; this is deliberately stricter, because that
///     silence is the same failure the three hand-rolled bridges each
///     invented a timeout to survive.)
pub struct Responder {
    id: Option<Value>,
    write_tx: mpsc::Sender<Vec<u8>>,
}

impl Responder {
    pub(crate) fn new(id: Value, write_tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self { id: Some(id), write_tx }
    }

    /// Answer with a result. `Value::Null` is a valid success payload.
    pub fn ok(mut self, result: Value) {
        if let Some(id) = self.id.take() {
            let body = Response { jsonrpc: "2.0", id: &id, result: &result };
            self.send(serde_json::to_vec(&body));
        }
    }

    /// Answer with an error.
    pub fn err(mut self, code: i64, message: &str) {
        if let Some(id) = self.id.take() {
            self.send_error(&id, code, message);
        }
    }

    fn send_error(&self, id: &Value, code: i64, message: &str) {
        let body = ErrorResponse {
            jsonrpc: "2.0",
            id,
            error: RpcError { code, message, data: None },
        };
        self.send(serde_json::to_vec(&body));
    }

    fn send(&self, payload: Result<Vec<u8>, serde_json::Error>) {
        let payload = match payload {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[sidecar] failed to serialize reply: {e}");
                return;
            }
        };
        // `try_send`, never `send().await` — see the reader loop. It is also
        // the only primitive `Drop` can use, so both paths share one route
        // rather than diverging into "the tested one" and "the other one".
        if let Err(e) = self.write_tx.try_send(encode(&payload)) {
            eprintln!("[sidecar] dropped outbound reply: {e}");
        }
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.send_error(&id, INTERNAL_ERROR, "handler dropped without answering");
        }
    }
}

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
        on_request: Option<RequestHandler>,
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
            on_request,
            write_tx.clone(),
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
        on_request: Option<RequestHandler>,
        on_exit: Option<ExitHandler>,
    ) -> Result<Self, SidecarError> {
        let client =
            Self::spawn(program, args, extra_env, on_notification, on_request, on_exit).await?;
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

// Generic over the source rather than taking `ChildStdout`, so the dispatch
// below can be driven from an in-memory pipe. It is the only classifier on this
// side of the wire and it had no test of any kind.
async fn reader_loop<R: AsyncRead + Unpin>(
    mut stdout: R,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
    on_notification: NotificationHandler,
    on_request: Option<RequestHandler>,
    // Reply path for inbound requests. Owned rather than borrowed so this stays
    // a free async fn we can hand straight to `tokio::spawn`.
    write_tx: mpsc::Sender<Vec<u8>>,
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

            // JSON-RPC 2.0 classifies a frame by WHICH of `id` and `method` are
            // present. Match the pair exhaustively rather than testing one and
            // falling through to the other: testing `id` first and never
            // consulting `method` routed inbound *requests* (which carry both)
            // into the response path, where they matched no pending entry and
            // vanished without a trace. Making every combination a named arm
            // stops "which check runs first" from being load-bearing —
            // rust-analyzer's `lsp-server` carries the mirror-image bug via
            // untagged-enum variant order and recently hardened against it.
            //
            // Note `id: null` deserializes to `None`, not `Some(Value::Null)`,
            // so a null-id frame lands in the method arms. That is the right
            // answer (a null id is not addressable) but it is incidental —
            // widening the field type would silently change it.
            match (incoming.id, incoming.method) {
                // Request. Nothing inbound is handled yet, so refuse it. A peer
                // told "no" recovers; a peer ignored waits forever. When the
                // first real handler lands this arm gains a lookup, and the
                // refusal stays as the default for anything unknown.
                (Some(id), Some(method)) => {
                    // The responder carries THIS client's write channel, so the
                    // reply cannot land on the wrong sidecar — that identity is
                    // why the handler is built per client rather than shared.
                    //
                    // Called inline, and the handler contract is that it does
                    // not block: this task is the only drainer of the peer's
                    // stdout, so awaiting here would stall every inbound frame
                    // including `chat/event` for every run. Handlers that need
                    // to wait (the realistic case — the answer comes from the
                    // frontend) move the responder into a spawned task.
                    let responder = Responder::new(id, write_tx.clone());
                    match &on_request {
                        Some(handler) => handler(method, incoming.params.unwrap_or(Value::Null), responder),
                        // Nothing serves inbound requests on this client. Refuse
                        // rather than ignore: a peer told "no" recovers, a peer
                        // ignored waits forever.
                        None => responder.err(METHOD_NOT_FOUND, &format!("method not found: {method}")),
                    }
                }

                // Response to one of our requests. Don't gate on
                // `result`/`error` — `result: null` is a valid success payload
                // that serde reads as `None`.
                (Some(id), None) => {
                    // We only ever mint integer ids, so a non-integer id can't
                    // correlate to anything. Say so rather than coercing to -1
                    // and pretending to look it up.
                    let Some(key) = id.as_i64() else {
                        eprintln!("[sidecar] response with non-integer id {id}; dropping");
                        continue;
                    };
                    let outcome = if let Some(err) = incoming.error {
                        Err(SidecarError::Rpc {
                            code: err.code,
                            message: err.message,
                            data: err.data,
                        })
                    } else {
                        Ok(incoming.result.unwrap_or(Value::Null))
                    };
                    if let Some(tx) = pending.lock().await.remove(&key) {
                        let _ = tx.send(outcome);
                    }
                }

                // Notification. Stays inline and therefore ordered: the
                // frontend's streaming assembly depends on wire order.
                (None, Some(method)) => {
                    on_notification(method, incoming.params.unwrap_or(Value::Null));
                }

                // Neither: not addressable (no id to reply to) and not
                // actionable (no method to dispatch). The sidecar produces this
                // for `errorResponse(null, -32700, 'Parse error')` when it
                // can't parse something we sent — which means a request of ours
                // is about to hang until the child dies. It used to vanish with
                // no output at all.
                (None, None) => {
                    eprintln!(
                        "[sidecar] unaddressable frame (no id, no method): {}",
                        String::from_utf8_lossy(&payload),
                    );
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Frames `payloads` into an in-memory reader, runs the real dispatch over
    /// it, and returns the notifications it delivered. The loop ends at EOF.
    async fn dispatch(
        payloads: &[&str],
        pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
    ) -> Vec<(String, Value)> {
        dispatch_full(payloads, pending).await.0
    }

    /// As `dispatch`, but also returns every frame the loop wrote back out,
    /// decoded through the real `FrameParser` — so a reply that forgot to be
    /// framed fails here rather than confusing the peer at runtime.
    ///
    /// Capacity matches production (64). An unbounded channel would hide the
    /// very backpressure behaviour the design turns on.
    async fn dispatch_full(
        payloads: &[&str],
        pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
    ) -> (Vec<(String, Value)>, Vec<Value>) {
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(64);
        dispatch_with(payloads, pending, write_tx, write_rx).await
    }

    /// The general form: the caller supplies the write channel, so a test can
    /// pre-saturate it. `write_tx` is MOVED in — the helper must not retain a
    /// sender, or the drain below never observes the channel close and hangs.
    async fn dispatch_with(
        payloads: &[&str],
        pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
        write_tx: mpsc::Sender<Vec<u8>>,
        mut write_rx: mpsc::Receiver<Vec<u8>>,
    ) -> (Vec<(String, Value)>, Vec<Value>) {
        let mut wire = Vec::new();
        for p in payloads {
            wire.extend_from_slice(&encode(p.as_bytes()));
        }
        let seen: Arc<StdMutex<Vec<(String, Value)>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let handler: NotificationHandler =
            Arc::new(move |m, p| sink.lock().unwrap().push((m, p)));

        reader_loop(std::io::Cursor::new(wire), pending, handler, None, write_tx).await;

        let mut parser = FrameParser::new();
        while let Some(frame) = write_rx.recv().await {
            parser.push(&frame);
        }
        let mut out = Vec::new();
        while let Some(p) = parser.next_message() {
            out.push(serde_json::from_slice::<Value>(&p).expect("outbound frame is valid JSON"));
        }
        let notifications = seen.lock().unwrap().clone();
        (notifications, out)
    }

    fn slot() -> (
        Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, SidecarError>>>>>,
        oneshot::Receiver<Result<Value, SidecarError>>,
        i64,
    ) {
        let (tx, rx) = oneshot::channel();
        let map = HashMap::from([(7i64, tx)]);
        (Arc::new(Mutex::new(map)), rx, 7)
    }

    #[tokio::test]
    async fn a_response_resolves_its_pending_request() {
        let (pending, rx, id) = slot();
        dispatch(&[&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"ok":true}}}}"#)], pending)
            .await;
        let got = rx.await.expect("resolved").expect("ok");
        assert_eq!(got, serde_json::json!({"ok": true}));
    }

    #[tokio::test]
    async fn a_null_result_still_resolves() {
        // `result: null` is a valid success payload and serde reads it as None;
        // gating on result/error rather than on `id` would drop it.
        let (pending, rx, id) = slot();
        dispatch(&[&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":null}}"#)], pending).await;
        assert_eq!(rx.await.expect("resolved").expect("ok"), Value::Null);
    }

    #[tokio::test]
    async fn an_error_response_resolves_as_rpc_error() {
        let (pending, rx, id) = slot();
        dispatch(
            &[&format!(
                r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32000,"message":"nope"}}}}"#
            )],
            pending,
        )
        .await;
        match rx.await.expect("resolved") {
            Err(SidecarError::Rpc { code, message, .. }) => {
                assert_eq!(code, -32000);
                assert_eq!(message, "nope");
            }
            other => panic!("expected Rpc, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_notification_reaches_the_handler() {
        let seen = dispatch(
            &[r#"{"jsonrpc":"2.0","method":"chat/event","params":{"runId":"r1"}}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "chat/event");
        assert_eq!(seen[0].1, serde_json::json!({"runId": "r1"}));
    }

    #[tokio::test]
    async fn a_malformed_frame_is_skipped_not_fatal() {
        // One bad payload must not cost us the rest of the stream.
        let seen = dispatch(
            &[r#"{not json"#, r#"{"jsonrpc":"2.0","method":"after","params":null}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert_eq!(seen.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(), ["after"]);
    }

    // --- inbound requests -------------------------------------------------
    //
    // A frame carrying BOTH `id` and `method` is a request. Nothing inbound is
    // handled yet, so the contract is that it is REFUSED, not ignored: a peer
    // told "no" recovers, a peer ignored waits forever.

    #[tokio::test]
    async fn an_inbound_request_gets_method_not_found() {
        let (seen, out) = dispatch_full(
            &[r#"{"jsonrpc":"2.0","id":42,"method":"fs/readTextFile","params":{"p":"/x"}}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert!(seen.is_empty(), "a request is not a notification");
        assert_eq!(out.len(), 1, "exactly one framed reply");
        assert_eq!(out[0]["jsonrpc"], "2.0");
        assert_eq!(out[0]["id"], 42);
        assert_eq!(out[0]["error"]["code"], METHOD_NOT_FOUND);
        assert!(out[0].get("result").is_none(), "an error response carries no result");
    }

    #[tokio::test]
    async fn a_string_id_round_trips_unmangled() {
        // JSON-RPC ids may be strings. Coercing through i64 answers `id: -1`,
        // i.e. replies to a request the peer never made.
        let (_, out) = dispatch_full(
            &[r#"{"jsonrpc":"2.0","id":"req-abc","method":"whatever"}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], serde_json::json!("req-abc"));
    }

    #[tokio::test]
    async fn a_request_is_not_mistaken_for_a_response() {
        // The ordering pin. Testing `id` first and never consulting `method`
        // routed requests into the response path, where they resolved (or
        // silently missed) a pending entry. Here id 7 IS pending, so a
        // misclassification is directly observable.
        let (pending, rx, id) = slot();
        let (_, out) = dispatch_full(
            &[&format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"anything"}}"#)],
            pending,
        )
        .await;
        assert_eq!(out.len(), 1, "the request must be answered");
        assert_eq!(out[0]["error"]["code"], METHOD_NOT_FOUND);
        // ...and must NOT have resolved the pending request. It falls to the
        // EOF sweep instead.
        assert!(matches!(rx.await.expect("resolved"), Err(SidecarError::Exited)));
    }

    #[tokio::test]
    async fn a_notification_writes_nothing_back() {
        // The inverse misroute. Replying to a notification is a protocol
        // violation and would desync the peer's own id table.
        let (seen, out) = dispatch_full(
            &[r#"{"jsonrpc":"2.0","method":"chat/event","params":{"runId":"r1"}}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert_eq!(seen.len(), 1);
        assert!(out.is_empty(), "notifications are not answered");
    }

    #[tokio::test]
    async fn an_id_less_error_response_is_not_misrouted() {
        // The sidecar answers an unparseable frame with
        // `errorResponse(null, -32700, 'Parse error')` (server.mjs:338). Serde
        // reads JSON null into Option<Value> as None, so that frame has neither
        // id nor method and fell through every branch with no log — meaning a
        // frame we failed to encode correctly hung its caller until the child
        // died. It is not addressable, but it must not be invisible.
        let (pending, rx, _) = slot();
        let (seen, out) = dispatch_full(
            &[r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#],
            pending,
        )
        .await;
        assert!(seen.is_empty(), "not a notification");
        assert!(out.is_empty(), "nothing to reply to — there is no id");
        // It must not be mistaken for a reply to something we asked.
        assert!(matches!(rx.await.expect("resolved"), Err(SidecarError::Exited)));
    }

    #[tokio::test]
    async fn a_saturated_write_channel_does_not_stall_notifications() {
        // `reader_loop` is the only drainer of the peer's stdout, and
        // `writer_loop` the only drainer of this channel. Blocking the reader
        // on a full channel creates the condition that keeps it full, so one
        // unanswerable request would freeze streaming for every run. Under
        // `send().await` this test hangs; under a non-blocking send it passes.
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(64);
        for _ in 0..64 {
            write_tx.try_send(b"x".to_vec()).expect("fill to capacity");
        }
        let (seen, _) = dispatch_with(
            &[
                r#"{"jsonrpc":"2.0","id":1,"method":"unhandled"}"#,
                r#"{"jsonrpc":"2.0","method":"chat/event","params":{"runId":"r1"}}"#,
            ],
            Arc::new(Mutex::new(HashMap::new())),
            write_tx,
            write_rx,
        )
        .await;
        assert_eq!(
            seen.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(),
            ["chat/event"],
            "the event stream must survive an unanswerable request",
        );
    }

    // --- request handlers -------------------------------------------------

    /// Runs the loop with a request handler installed.
    async fn dispatch_handled(
        payloads: &[&str],
        on_request: RequestHandler,
    ) -> Vec<Value> {
        let mut wire = Vec::new();
        for p in payloads {
            wire.extend_from_slice(&encode(p.as_bytes()));
        }
        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
        let noop: NotificationHandler = Arc::new(|_, _| {});
        reader_loop(
            std::io::Cursor::new(wire),
            Arc::new(Mutex::new(HashMap::new())),
            noop,
            Some(on_request),
            write_tx,
        )
        .await;
        // The handler may answer from a spawned task, so give it a turn before
        // the channel is drained.
        tokio::task::yield_now().await;
        let mut parser = FrameParser::new();
        while let Some(frame) = write_rx.recv().await {
            parser.push(&frame);
        }
        let mut out = Vec::new();
        while let Some(p) = parser.next_message() {
            out.push(serde_json::from_slice::<Value>(&p).expect("valid JSON"));
        }
        out
    }

    #[tokio::test]
    async fn a_handled_request_gets_the_handlers_answer() {
        let handler: RequestHandler = Arc::new(|method, params, responder| {
            responder.ok(serde_json::json!({ "saw": method, "echo": params }));
        });
        let out = dispatch_handled(
            &[r#"{"jsonrpc":"2.0","id":7,"method":"host/ping","params":{"n":1}}"#],
            handler,
        )
        .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], 7);
        assert_eq!(out[0]["result"]["saw"], "host/ping");
        assert_eq!(out[0]["result"]["echo"]["n"], 1);
    }

    #[tokio::test]
    async fn a_handler_can_answer_from_another_task() {
        // The realistic shape: the answer comes from the frontend, minutes
        // later. The responder must survive being moved off the reader.
        let handler: RequestHandler = Arc::new(|_m, _p, responder| {
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                responder.ok(serde_json::json!("late"));
            });
        });
        let out = dispatch_handled(&[r#"{"jsonrpc":"2.0","id":1,"method":"host/x"}"#], handler)
            .await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["result"], "late");
    }

    #[tokio::test]
    async fn a_dropped_responder_still_answers() {
        // The guarantee the whole type exists for. A handler that panics,
        // early-returns, or simply forgets must not leave the peer waiting
        // forever — that is the failure mode the three hand-rolled bridges
        // each invented a timeout to survive. (The ACP Rust SDK's responder
        // sends nothing on drop; this is deliberately stricter.)
        let handler: RequestHandler = Arc::new(|_m, _p, _responder| { /* drops it */ });
        let out = dispatch_handled(&[r#"{"jsonrpc":"2.0","id":"abc","method":"host/x"}"#], handler)
            .await;
        assert_eq!(out.len(), 1, "exactly one reply, even unanswered");
        assert_eq!(out[0]["id"], serde_json::json!("abc"));
        assert_eq!(out[0]["error"]["code"], INTERNAL_ERROR);
    }

    #[tokio::test]
    async fn a_responder_answers_exactly_once() {
        // `ok` consumes the responder, so a second send is unrepresentable —
        // but Drop still runs afterwards and must not add a second frame.
        let handler: RequestHandler = Arc::new(|_m, _p, responder| {
            responder.ok(serde_json::json!("first"));
        });
        let out = dispatch_handled(&[r#"{"jsonrpc":"2.0","id":1,"method":"host/x"}"#], handler)
            .await;
        assert_eq!(out.len(), 1, "Drop must not double-send after ok()");
        assert_eq!(out[0]["result"], "first");
        assert!(out[0].get("error").is_none());
    }

    #[tokio::test]
    async fn a_null_result_is_serialized_not_omitted() {
        // A response carrying neither result nor error is malformed, and the
        // peer classifies on `result` being present. Easy to "tidy up" into a
        // protocol violation with a skip_serializing_if.
        let handler: RequestHandler = Arc::new(|_m, _p, responder| responder.ok(Value::Null));
        let out = dispatch_handled(&[r#"{"jsonrpc":"2.0","id":1,"method":"host/x"}"#], handler)
            .await;
        assert_eq!(out[0].get("result"), Some(&Value::Null));
    }

    #[tokio::test]
    async fn an_unhandled_method_still_gets_method_not_found() {
        // With no handler installed at all, the refusal from the previous
        // commit must still stand.
        let (_, out) = dispatch_full(
            &[r#"{"jsonrpc":"2.0","id":1,"method":"host/x"}"#],
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        assert_eq!(out[0]["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn eof_fails_every_still_pending_request() {
        // The one guarantee the transport owes callers: nobody hangs when the
        // peer goes away.
        let (pending, rx, _) = slot();
        dispatch(&[], pending).await;
        assert!(matches!(rx.await.expect("resolved"), Err(SidecarError::Exited)));
    }
}
