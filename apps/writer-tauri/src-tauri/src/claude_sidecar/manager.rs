// Owns the chat + title sidecar processes for the lifetime of the app,
// and supervises them — when a child exits unexpectedly, we respawn the
// affected sidecar in place so frontend invocations resume working.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use super::client::{
    ExitHandler, NotificationHandler, RequestHandler, SidecarClient, SidecarError, INVALID_PARAMS,
    METHOD_NOT_FOUND,
};
use super::pending_frontend::PendingFrontend;
use super::state::{set_sidecar_state, SidecarState};

// Self-reference handle for exit closures. Set after the SidecarManager Arc
// is created, so the closures can find their way back to call restart_*.
type SelfRef = Arc<OnceLock<Weak<SidecarManager>>>;

#[derive(Copy, Clone, Debug)]
enum Mode {
    Chat,
    Title,
}

impl Mode {
    fn as_str(&self) -> &'static str {
        match self {
            Mode::Chat => "chat",
            Mode::Title => "title",
        }
    }
}

// Crash-loop supervision. A sidecar that dies is respawned, but a sidecar that
// dies *immediately and repeatedly* (e.g. a broken bundle in a packaged build)
// must not hot-loop forever pegging the CPU and flooding logs. Each respawn
// waits an exponentially growing backoff, and after too many consecutive fast
// deaths we stop trying and surface a terminal `SidecarState::Dead { fatal }`.
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;
/// An instance that lived at least this long before dying is treated as a
/// healthy process that eventually died — not a crash loop — so its death
/// resets the consecutive counter instead of escalating it.
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
const RESTART_BACKOFF_BASE_MS: u64 = 500;
const RESTART_BACKOFF_CAP_MS: u64 = 30_000;

/// Per-mode crash-loop state. `consecutive` counts back-to-back fast deaths;
/// `last_spawn` dates the current instance so `handle_exit` can tell a loop
/// from an isolated death.
struct RestartGuard {
    consecutive: u32,
    last_spawn: Instant,
}

#[derive(Debug)]
enum RestartAction {
    /// Wait this long, then respawn.
    Backoff(Duration),
    /// Too many consecutive fast deaths — stop trying.
    GiveUp,
    /// We asked for this exit (app quit). Leave it alone — respawning here
    /// would resurrect a sidecar the app is in the middle of tearing down.
    Expected,
}

/// Pure crash-loop policy. Given whether the app is shutting down, the
/// consecutive-fast-death count so far, and how long the just-dead instance
/// lived, return the updated count and what to do next. Extracted from
/// `handle_exit` so the escalation math is unit-tested without spawning real
/// processes.
fn restart_decision(
    shutting_down: bool,
    prev_consecutive: u32,
    lived: Duration,
) -> (u32, RestartAction) {
    // Supervision is for deaths we didn't ask for. A sidecar leaving because we
    // told it to says nothing about its health, so it neither respawns nor
    // spends crash-loop budget.
    if shutting_down {
        return (prev_consecutive, RestartAction::Expected);
    }
    // A death after a healthy run is an isolated incident, not a loop: reset
    // the streak (this death counts as the first restart).
    let consecutive = if lived >= HEALTHY_UPTIME {
        1
    } else {
        prev_consecutive.saturating_add(1)
    };
    if consecutive > MAX_CONSECUTIVE_RESTARTS {
        return (consecutive, RestartAction::GiveUp);
    }
    let shift = consecutive.saturating_sub(1).min(20);
    let ms = RESTART_BACKOFF_BASE_MS
        .saturating_mul(1u64 << shift)
        .min(RESTART_BACKOFF_CAP_MS);
    (consecutive, RestartAction::Backoff(Duration::from_millis(ms)))
}

/// How a sidecar is launched. Captured at startup so restarts use the same
/// command + env without re-resolving paths.
#[derive(Clone)]
struct Launcher {
    program: PathBuf,
    /// Args that come BEFORE `--mode=...`. In dev that's the .mjs script
    /// path; in prod it's empty.
    pre_args: Vec<String>,
    /// Extra env vars layered on top of the inherited env.
    env: Vec<(&'static str, OsString)>,
}

impl Launcher {
    fn args_for(&self, mode: &str) -> Vec<String> {
        let mut args = self.pre_args.clone();
        args.push(format!("--mode={mode}"));
        args
    }
}

pub struct SidecarManager {
    chat: RwLock<Arc<SidecarClient>>,
    title: RwLock<Arc<SidecarClient>>,
    self_ref: SelfRef,
    notification_handler: NotificationHandler,
    /// Requests from the chat sidecar that the frontend has to answer. Only
    /// the chat sidecar can ask — the title sidecar runs one-shot completions
    /// and has no relay tools.
    pending_frontend: Arc<PendingFrontend>,
    launcher: Launcher,
    app: AppHandle,
    chat_restart: Mutex<RestartGuard>,
    title_restart: Mutex<RestartGuard>,
    /// Set once `shutdown_all` starts, and never cleared — the app is on its
    /// way out. Read by the supervisor so the graceful exits we're about to
    /// request aren't mistaken for crashes.
    shutting_down: AtomicBool,
}

impl SidecarManager {
    pub async fn spawn_all(app: &AppHandle) -> Result<Arc<Self>, SidecarError> {
        let launcher = resolve_launcher(app)?;
        eprintln!(
            "[sidecar manager] spawning chat + title sidecars\n  program: {}\n  args: {:?}\n  env: {:?}",
            launcher.program.display(),
            launcher.pre_args,
            launcher.env.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
        );

        let handler = build_notification_handler(app.clone());
        let pending_frontend = Arc::new(PendingFrontend::new());
        let self_ref: SelfRef = Arc::new(OnceLock::new());

        let chat_exit = build_exit(self_ref.clone(), Mode::Chat);
        let title_exit = build_exit(self_ref.clone(), Mode::Title);

        set_sidecar_state(app, SidecarState::Starting { mode: Mode::Chat.as_str().into() });
        set_sidecar_state(app, SidecarState::Starting { mode: Mode::Title.as_str().into() });

        let chat = SidecarClient::spawn_initialized(
            &launcher.program,
            &launcher.args_for("chat"),
            &launcher.env,
            handler.clone(),
            Some(build_request_handler(app.clone(), pending_frontend.clone())),
            Some(chat_exit),
        )
        .await?;
        let title = SidecarClient::spawn_initialized(
            &launcher.program,
            &launcher.args_for("title"),
            &launcher.env,
            handler.clone(),
            None,
            Some(title_exit),
        )
        .await?;

        eprintln!("[sidecar manager] both sidecars initialized");

        set_sidecar_state(app, SidecarState::Running { mode: Mode::Chat.as_str().into() });
        set_sidecar_state(app, SidecarState::Running { mode: Mode::Title.as_str().into() });

        let mgr = Arc::new(Self {
            chat: RwLock::new(Arc::new(chat)),
            title: RwLock::new(Arc::new(title)),
            self_ref: self_ref.clone(),
            notification_handler: handler,
            pending_frontend,
            launcher,
            app: app.clone(),
            chat_restart: Mutex::new(RestartGuard { consecutive: 0, last_spawn: Instant::now() }),
            title_restart: Mutex::new(RestartGuard { consecutive: 0, last_spawn: Instant::now() }),
            shutting_down: AtomicBool::new(false),
        });

        // Wire the self-ref so the exit closures can find us when they fire.
        // Setting once is sufficient; the OnceLock is shared across closures.
        let _ = self_ref.set(Arc::downgrade(&mgr));

        // Dev convenience: hot-restart the sidecars when their source changes.
        // The Node process loads server.mjs once at spawn, so edits don't apply
        // until a respawn — this watcher does that automatically so `tauri dev`
        // picks up sidecar edits without a full app restart.
        #[cfg(debug_assertions)]
        spawn_sidecar_dev_watcher(self_ref.clone(), app.clone());

        match mgr.try_inject_token(app).await {
            Ok(true) => eprintln!("[sidecar manager] token injected at startup"),
            Ok(false) => {
                eprintln!("[sidecar manager] no OAuth token yet; chat will fail until sign-in")
            }
            Err(e) => eprintln!("[sidecar manager] startup token inject failed: {e}"),
        }
        Ok(mgr)
    }

    /// Snapshots the current chat client. Cheap; just clones an Arc.
    pub async fn chat_client(&self) -> Arc<SidecarClient> {
        self.chat.read().await.clone()
    }

    /// Requests from the chat sidecar still waiting on a frontend answer.
    pub fn pending_frontend(&self) -> &Arc<PendingFrontend> {
        &self.pending_frontend
    }

    /// Snapshots the current title client.
    pub async fn title_client(&self) -> Arc<SidecarClient> {
        self.title.read().await.clone()
    }

    /// Gracefully tears down both sidecars on app quit. We send each a
    /// `shutdown` notification so its Node process aborts in-flight chats —
    /// which lets the SDK reap its `claude` CLI grandchild (no orphan) and
    /// flush the session to ~/.claude/projects (so resume stays intact) —
    /// then wait a bounded grace for the processes to actually exit.
    ///
    /// This is the graceful path, and it's the fix for the observed orphans:
    /// app quit ends in `std::process::exit`, which skips `Drop` so
    /// `kill_on_drop` never fires. Telling the sidecars to leave *before* we
    /// exit is what tears the process tree down cleanly. After the grace we
    /// hard-kill each process group as a backstop, so a hung sidecar (or a CLI
    /// grandchild the graceful path didn't reap in time) still can't outlive us.
    pub async fn shutdown_all(&self, grace: std::time::Duration) {
        // Before we ask, not after: the sidecars exit within ~250ms and the
        // supervisor reads any exit as a crash worth respawning. Left armed, a
        // quit would spawn a fresh sidecar mid-teardown — and `app.exit(0)`
        // skips `Drop`, so that one really would be orphaned.
        self.shutting_down.store(true, Ordering::SeqCst);

        let chat = self.chat_client().await;
        let title = self.title_client().await;

        // Fire-and-forget: a notification has no id, so the Node router runs its
        // graceful shutdown and exits without owing us a response.
        let _ = chat.notify("shutdown", None).await;
        let _ = title.notify("shutdown", None).await;

        // Let the graceful exit + session flush complete before the caller
        // proceeds to process exit. The Node side flushes then exits within
        // ~250ms; the grace gives margin without stalling quit noticeably.
        tokio::time::sleep(grace).await;

        // Backstop: SIGKILL each process group. No-op for the already-exited
        // common case; the guarantee for the hung / slow-reap case.
        chat.hard_kill();
        title.hard_kill();
    }

    /// Read the latest OAuth token (auto-refreshing if near expiry). A read
    /// failure logs and yields None rather than propagating — callers treat
    /// "no token" and "couldn't read the token" the same (chat fails cleanly).
    async fn read_token(&self, app: &AppHandle) -> Option<String> {
        match crate::oauth::get_claude_token(app.clone()).await {
            Ok(opt) => opt,
            Err(e) => {
                eprintln!("[sidecar manager] failed to read OAuth token: {e}");
                None
            }
        }
    }

    /// Reads the latest token and pushes it to BOTH sidecars. Used at startup
    /// and on `auth/refreshNeeded` — best-effort, not tied to a single request.
    /// Returns Ok(true) if a token was injected, Ok(false) if none is available.
    pub async fn try_inject_token(&self, app: &AppHandle) -> Result<bool, SidecarError> {
        match self.read_token(app).await {
            Some(t) => {
                self.set_token(&t).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Inject the current token into ONLY the chat sidecar. Called before a
    /// chat start so a title sidecar that's mid-restart (or crash-looping)
    /// can't block a chat request — the two hold their tokens independently.
    pub async fn try_inject_token_chat(&self, app: &AppHandle) -> Result<bool, SidecarError> {
        self.try_inject_token_for(app, Mode::Chat).await
    }

    /// Inject the current token into ONLY the title sidecar. Symmetric to
    /// `try_inject_token_chat` — a title request doesn't depend on chat health.
    pub async fn try_inject_token_title(&self, app: &AppHandle) -> Result<bool, SidecarError> {
        self.try_inject_token_for(app, Mode::Title).await
    }

    async fn try_inject_token_for(&self, app: &AppHandle, mode: Mode) -> Result<bool, SidecarError> {
        match self.read_token(app).await {
            Some(t) => {
                self.set_token_on(mode, &t).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Sends `setToken` to both sidecars. Idempotent — safe to call repeatedly
    /// to rotate the OAuth token without restarting either process.
    pub async fn set_token(&self, token: &str) -> Result<(), SidecarError> {
        self.set_token_on(Mode::Chat, token).await?;
        self.set_token_on(Mode::Title, token).await?;
        Ok(())
    }

    /// Sends `setToken` to a single sidecar.
    async fn set_token_on(&self, mode: Mode, token: &str) -> Result<(), SidecarError> {
        let client = match mode {
            Mode::Chat => self.chat_client().await,
            Mode::Title => self.title_client().await,
        };
        let _: Value = client
            .request("setToken", Some(json!({ "token": token })))
            .await?;
        Ok(())
    }

    fn restart_guard(&self, mode: Mode) -> &Mutex<RestartGuard> {
        match mode {
            Mode::Chat => &self.chat_restart,
            Mode::Title => &self.title_restart,
        }
    }

    /// Called from the exit handler when a sidecar dies. Applies crash-loop
    /// supervision — exponential backoff between respawns, and a hard cap on
    /// consecutive fast deaths — then respawns (or gives up terminally).
    async fn handle_exit(&self, mode: Mode) {
        // Decide backoff vs give-up from how the just-dead instance behaved.
        // The lock is released at the end of this block, before any await.
        let (attempt, action) = {
            let mut g = self.restart_guard(mode).lock().unwrap();
            let (next, action) = restart_decision(
                self.shutting_down.load(Ordering::SeqCst),
                g.consecutive,
                g.last_spawn.elapsed(),
            );
            g.consecutive = next;
            (next, action)
        };

        let delay = match action {
            // Not our business: the app asked this sidecar to leave. Returning
            // before the `Restarting` emit also keeps a quit from flashing a
            // respawn the user will never see the end of.
            RestartAction::Expected => return,
            RestartAction::GiveUp => {
                eprintln!(
                    "[sidecar manager] {} sidecar crash-looped past {} restarts; giving up",
                    mode.as_str(),
                    MAX_CONSECUTIVE_RESTARTS,
                );
                set_sidecar_state(
                    &self.app,
                    SidecarState::Dead { mode: mode.as_str().into(), fatal: true },
                );
                return;
            }
            RestartAction::Backoff(d) => d,
        };

        // Announce the impending respawn. Consumers settle in-flight work on
        // this transition. `attempt` is the consecutive-fast-death count; the
        // process is gone until the next `Running`.
        set_sidecar_state(
            &self.app,
            SidecarState::Restarting {
                mode: mode.as_str().into(),
                attempt,
                max: MAX_CONSECUTIVE_RESTARTS,
            },
        );

        if !delay.is_zero() {
            eprintln!(
                "[sidecar manager] {} sidecar respawn backoff {}ms",
                mode.as_str(),
                delay.as_millis(),
            );
            tokio::time::sleep(delay).await;
        }

        if let Err(e) = self.restart(mode).await {
            // The respawn itself failed, so no new exit handler was armed —
            // nothing will retry. Surface a terminal signal instead of leaving
            // the sidecar silently dead.
            eprintln!(
                "[sidecar manager] {} sidecar restart failed: {e}",
                mode.as_str()
            );
            set_sidecar_state(
                &self.app,
                SidecarState::Dead { mode: mode.as_str().into(), fatal: true },
            );
        }
    }

    async fn restart(&self, mode: Mode) -> Result<(), SidecarError> {
        eprintln!("[sidecar manager] {} sidecar exited; respawning", mode.as_str());
        // The process that asked these questions is gone, so its answers have
        // nowhere to land. Release them here rather than on the next spawn:
        // if the respawn itself fails we return early, and the slots would
        // otherwise sit there across every subsequent restart.
        if matches!(mode, Mode::Chat) {
            let released = self.pending_frontend.release_all().await;
            if released > 0 {
                eprintln!("[sidecar manager] released {released} pending frontend request(s)");
            }
        }
        let exit_handler = build_exit(self.self_ref.clone(), mode);
        let request_handler = matches!(mode, Mode::Chat)
            .then(|| build_request_handler(self.app.clone(), self.pending_frontend.clone()));
        let client = SidecarClient::spawn_initialized(
            &self.launcher.program,
            &self.launcher.args_for(mode.as_str()),
            &self.launcher.env,
            self.notification_handler.clone(),
            request_handler,
            Some(exit_handler),
        )
        .await?;
        let new_arc = Arc::new(client);

        match mode {
            Mode::Chat => *self.chat.write().await = new_arc.clone(),
            Mode::Title => *self.title.write().await = new_arc.clone(),
        }

        // Push the latest token to the freshly-spawned process.
        if let Ok(Some(token)) = crate::oauth::get_claude_token(self.app.clone()).await {
            let _: Value = new_arc
                .request("setToken", Some(json!({ "token": token })))
                .await?;
        }

        // Date the fresh instance so the next death can measure its uptime.
        self.restart_guard(mode).lock().unwrap().last_spawn = Instant::now();

        eprintln!("[sidecar manager] {} sidecar respawned", mode.as_str());
        set_sidecar_state(&self.app, SidecarState::Running { mode: mode.as_str().into() });
        Ok(())
    }
}

/// Map a sidecar notification method to the frontend Tauri event name the
/// bridge emits: `chat/<x>` → `claude:<x>`, any other `<ns>/<x>` → `<ns>:<x>`.
/// `None` for a non-namespaced method (no `/`), which the caller logs and drops.
/// `auth/refreshNeeded` is intercepted before this and never passed in.
fn notification_event_name(method: &str) -> Option<String> {
    let (ns, rest) = method.split_once('/')?;
    let prefix = if ns == "chat" { "claude" } else { ns };
    Some(format!("{prefix}:{rest}"))
}

fn build_notification_handler(app: AppHandle) -> NotificationHandler {
    Arc::new(move |method, params| {
        // auth/refreshNeeded is internal: the sidecar is asking the host
        // to push a fresh token. Do it asynchronously and don't surface
        // anything to the frontend — the retry will either succeed
        // silently or fail with chat/error AUTH.
        if method == "auth/refreshNeeded" {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app.try_state::<Arc<SidecarManager>>() {
                    let manager = state.inner().clone();
                    match manager.try_inject_token(&app).await {
                        Ok(true) => eprintln!("[sidecar manager] refreshed token after AUTH"),
                        Ok(false) => {
                            eprintln!("[sidecar manager] AUTH retry: no token available")
                        }
                        Err(e) => eprintln!("[sidecar manager] AUTH retry inject failed: {e}"),
                    }
                }
            });
            return;
        }
        // Forward every namespaced sidecar notification to the frontend as a
        // Tauri event by a mechanical rule: `chat/<x>` → `claude:<x>`, and any
        // other `<ns>/<x>` → `<ns>:<x>`. New channels flow through with zero
        // edits here, and an unexpected shape is logged rather than silently
        // dropped — the previous hardcoded match's `_ => return` swallowed any
        // method not in its table, so a new sidecar channel did nothing until
        // someone remembered to extend the table. (`auth/*` is host-internal
        // and already handled above; it never reaches this point.) The channel
        // catalogue and payload shapes live in PROTOCOL.md §4.
        let Some(event_name) = notification_event_name(&method) else {
            eprintln!("[sidecar manager] ignoring non-namespaced notification: {method}");
            return;
        };
        if let Err(e) = app.emit(event_name.as_str(), params) {
            eprintln!("[sidecar manager] emit {event_name} failed: {e}");
        }
    })
}

/// Serves the requests the sidecar asks the *host*, as opposed to the
/// notifications it merely announces. Built per client so the `Responder` it
/// hands out carries that client's write channel.
///
/// Every method here has the same shape, and it is forced by where the answer
/// lives: the host cannot produce one, so it parks the obligation, asks the
/// frontend, and the frontend's reply arrives later as its own
/// `#[tauri::command]`. Answering inline is not an option, and blocking is not
/// either — this runs on the reader task that drains the sidecar's stdout.
fn build_request_handler(app: AppHandle, pending: Arc<PendingFrontend>) -> RequestHandler {
    Arc::new(move |method, params, responder| {
        if method != "host/queryNotes" {
            responder.err(METHOD_NOT_FOUND, &format!("method not found: {method}"));
            return;
        }
        // Parked under the runId so a cancelled run releases it. Without one we
        // could park it but never know when to give up, so refuse instead.
        let Some(run_id) = params.get("runId").and_then(Value::as_str).map(str::to_owned) else {
            responder.err(INVALID_PARAMS, "host/queryNotes requires a runId");
            return;
        };
        let (app, pending) = (app.clone(), pending.clone());
        tauri::async_runtime::spawn(async move {
            // Park before emitting, never after: the frontend replies by
            // quoting the token, so the token has to exist before it can be
            // sent. The window where a slot is parked but unannounced is
            // closed by releasing it if the emit fails.
            let token = pending.park(run_id, responder).await;
            let mut payload = params;
            payload["queryId"] = json!(token);
            if let Err(e) = app.emit("claude:query-notes", payload) {
                eprintln!("[sidecar manager] emit claude:query-notes failed: {e}");
                pending.release(token).await;
            }
        });
    })
}

fn build_exit(self_ref: SelfRef, mode: Mode) -> ExitHandler {
    Arc::new(move || {
        // The observable death signal is emitted by `handle_exit` below, which
        // transitions the sidecar to `restarting` (respawning) or `dead`
        // (terminal). In-flight chat runs listen for that transition and settle
        // with an error instead of hanging forever on `claude:event` /
        // `claude:done` notifications that will never arrive once the producer
        // is gone.
        let self_ref = self_ref.clone();
        tauri::async_runtime::spawn(async move {
            let weak = match self_ref.get() {
                Some(w) => w.clone(),
                None => {
                    eprintln!(
                        "[sidecar manager] {} sidecar exited before manager wired up",
                        mode.as_str()
                    );
                    return;
                }
            };
            let Some(manager) = weak.upgrade() else { return };
            manager.handle_exit(mode).await;
        });
    })
}

/// Decide how to spawn sidecars on this build.
///
/// Dev: run the .mjs source through the system `node` so we can iterate
/// without rebuilding the Rust crate. Prod: run the compiled, self-contained
/// binary that Tauri ships next to the app's main executable, with no Node
/// dependency on the user's machine.
/// Dev-only: poll the sidecar source dir and respawn both sidecars when any
/// `.mjs` changes, so edits to `server.mjs` take effect without restarting the
/// whole app. The Node child loads the module once at spawn; only a respawn
/// reloads it. Polling (1s) avoids pulling in a filesystem-notify dependency.
#[cfg(debug_assertions)]
fn spawn_sidecar_dev_watcher(self_ref: SelfRef, app: AppHandle) {
    use std::time::{Duration, SystemTime};

    let dir = dev_paths::find_workspace_root(&app).join("apps/writer-tauri/sidecar/src");

    fn latest_mtime(dir: &std::path::Path) -> SystemTime {
        let mut latest = SystemTime::UNIX_EPOCH;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(modified) = entry.metadata().and_then(|md| md.modified()) {
                    if modified > latest {
                        latest = modified;
                    }
                }
            }
        }
        latest
    }

    tauri::async_runtime::spawn(async move {
        let mut last = latest_mtime(&dir);
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            // Manager not wired yet → wait; manager dropped → stop watching.
            let Some(weak) = self_ref.get() else { continue };
            let Some(mgr) = weak.upgrade() else { break };

            let now = latest_mtime(&dir);
            if now > last {
                // Let the editor finish writing before respawning.
                tokio::time::sleep(Duration::from_millis(300)).await;
                last = latest_mtime(&dir);
                eprintln!("[sidecar watcher] sidecar source changed — respawning sidecars");
                if let Err(e) = mgr.restart(Mode::Chat).await {
                    eprintln!("[sidecar watcher] chat respawn failed: {e}");
                }
                if let Err(e) = mgr.restart(Mode::Title).await {
                    eprintln!("[sidecar watcher] title respawn failed: {e}");
                }
            }
        }
    });
}

fn resolve_launcher(app: &AppHandle) -> Result<Launcher, SidecarError> {
    #[cfg(debug_assertions)]
    {
        let workspace_root = dev_paths::find_workspace_root(app);
        let script = workspace_root
            .join("apps")
            .join("writer-tauri")
            .join("sidecar")
            .join("src")
            .join("index.mjs");
        let node = dev_paths::which_node().unwrap_or_else(|| PathBuf::from("node"));
        // Dev: SDK can't see the platform-specific CLI from the .pnpm store,
        // so hand it the path explicitly. Prod's bundled node_modules makes
        // this unnecessary.
        let mut env: Vec<(&'static str, OsString)> = Vec::new();
        match dev_paths::resolve_claude_cli(app) {
            Some(cli) => {
                eprintln!("[sidecar manager] CLAUDE_CODE_CLI_PATH={}", cli.display());
                env.push(("CLAUDE_CODE_CLI_PATH", cli.into_os_string()));
            }
            None => eprintln!(
                "[sidecar manager] WARN: Claude CLI binary not found in .pnpm store; chat will fail"
            ),
        }
        return Ok(Launcher {
            program: node,
            pre_args: vec![script.to_string_lossy().to_string()],
            env,
        });
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        // Same shape as dev — bun runs the sidecar source — but the runtime
        // and the source come from the .app bundle instead of the user's
        // PATH and workspace. bun is an externalBin (next to the main exe),
        // the sidecar is shipped as a Resource.
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .ok_or_else(|| {
                SidecarError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "current_exe has no parent",
                ))
            })?;
        let bun_name = if cfg!(target_os = "windows") { "bun.exe" } else { "bun" };
        let bun_path = exe_dir.join(bun_name);
        if !bun_path.exists() {
            return Err(SidecarError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("bundled bun not found at {}", bun_path.display()),
            )));
        }
        // Tauri stages Resources at .app/Contents/Resources on macOS; from
        // the main exe at .app/Contents/MacOS/<bin>, that's `../Resources`.
        let resources = exe_dir
            .parent()
            .map(|p| p.join("Resources"))
            .unwrap_or_else(|| exe_dir.clone());
        // Tauri stages files referenced via parent paths under `_up_/`.
        let script = resources
            .join("_up_")
            .join("sidecar-pkg")
            .join("src")
            .join("index.mjs");
        if !script.exists() {
            return Err(SidecarError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("sidecar script not found at {}", script.display()),
            )));
        }
        return Ok(Launcher {
            program: bun_path,
            pre_args: vec!["run".into(), script.to_string_lossy().into_owned()],
            env: Vec::new(),
        });
    }
}

/// Dev-only path resolution. In prod the bundled .app contains everything
/// it needs at known relative locations, but in dev we have to discover the
/// workspace root + system tools at runtime.
#[cfg(debug_assertions)]
mod dev_paths {
    use std::path::{Path, PathBuf};
    use tauri::{AppHandle, Manager};

    /// Pull the platform-specific Claude CLI out of the .pnpm store. The SDK
    /// in prod auto-resolves from our bundled node_modules, but in dev the
    /// sidecar runs from the workspace and the SDK can't see .pnpm.
    pub fn resolve_claude_cli(app: &AppHandle) -> Option<PathBuf> {
        let workspace_root = find_workspace_root(app);
        let pnpm = workspace_root.join("node_modules").join(".pnpm");
        let pkg_prefix = if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "@anthropic-ai+claude-agent-sdk-darwin-arm64@"
        } else if cfg!(target_os = "macos") {
            "@anthropic-ai+claude-agent-sdk-darwin-x64@"
        } else if cfg!(target_os = "linux") {
            "@anthropic-ai+claude-agent-sdk-linux-x64@"
        } else if cfg!(target_os = "windows") {
            "@anthropic-ai+claude-agent-sdk-win32-x64@"
        } else {
            return None;
        };
        let cli_name = if cfg!(target_os = "windows") { "claude.exe" } else { "claude" };
        let pkg_inner = pkg_prefix.trim_end_matches('@').trim_start_matches("@anthropic-ai+");
        let entries = std::fs::read_dir(&pnpm).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(pkg_prefix) {
                let candidate = entry
                    .path()
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join(pkg_inner)
                    .join(cli_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    pub fn which_node() -> Option<PathBuf> {
        let path = std::env::var("PATH").ok()?;
        for dir in path.split(':') {
            let candidate = Path::new(dir).join("node");
            if candidate.exists() {
                return Some(candidate);
            }
        }
        None
    }

    pub fn find_workspace_root(app: &AppHandle) -> PathBuf {
        let mut dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        // Walk far enough for BOTH debug layouts. `tauri dev` starts at
        // src-tauri/target/debug (5 hops to the root), but a `tauri build --debug`
        // BUNDLE starts at target/debug/bundle/macos/<App>.app/Contents/Resources —
        // four levels deeper, i.e. 10 hops, which the old 0..10 bound missed by exactly
        // one (it fell back to "." → the sidecar script and the .pnpm Claude CLI both
        // resolved against the cwd and chat could never start in a debug bundle).
        // Generous cap: this only searches further before the same fallback.
        for _ in 0..20 {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: bool = false;
    const QUITTING: bool = true;

    fn backoff_ms(prev: u32, lived: Duration) -> u64 {
        match restart_decision(RUNNING, prev, lived).1 {
            RestartAction::Backoff(d) => d.as_millis() as u64,
            other => panic!("expected Backoff, got {other:?}"),
        }
    }

    #[test]
    fn fast_deaths_escalate_backoff() {
        // A fresh crash loop: each fast death grows the delay 0.5→1→2→4→8s.
        let fast = Duration::from_secs(1);
        assert_eq!(restart_decision(RUNNING, 0, fast).0, 1);
        assert_eq!(backoff_ms(0, fast), 500);
        assert_eq!(backoff_ms(1, fast), 1000);
        assert_eq!(backoff_ms(2, fast), 2000);
        assert_eq!(backoff_ms(3, fast), 4000);
        assert_eq!(backoff_ms(4, fast), 8000);
    }

    #[test]
    fn gives_up_past_the_cap() {
        // The 6th consecutive fast death (prev = MAX = 5) stops the loop.
        let (next, action) =
            restart_decision(RUNNING, MAX_CONSECUTIVE_RESTARTS, Duration::from_secs(1));
        assert_eq!(next, MAX_CONSECUTIVE_RESTARTS + 1);
        assert!(matches!(action, RestartAction::GiveUp));
    }

    #[test]
    fn healthy_run_resets_the_streak() {
        // A death after a healthy uptime drops the streak back to 1 and the
        // shortest backoff, even if the prior streak was near the cap.
        let (next, action) = restart_decision(RUNNING, MAX_CONSECUTIVE_RESTARTS, HEALTHY_UPTIME);
        assert_eq!(next, 1);
        assert!(matches!(action, RestartAction::Backoff(d) if d == Duration::from_millis(500)));
    }

    #[test]
    fn a_death_during_quit_is_expected_not_supervised() {
        // On quit we ask each sidecar to leave, and it exits within ~250ms —
        // well inside HEALTHY_UPTIME, so the crash-loop math would read it as a
        // fast death and respawn after a 500ms backoff. The app exits at 700ms,
        // so that respawn lands in a ~50ms window and leaves behind exactly the
        // orphan the graceful shutdown exists to avoid.
        let (next, action) = restart_decision(QUITTING, 3, Duration::from_millis(250));
        assert!(matches!(action, RestartAction::Expected));
        // And it must not spend crash-loop budget: an exit we asked for says
        // nothing about whether the sidecar is healthy.
        assert_eq!(next, 3, "an expected exit counted as a fast death");
    }

    #[test]
    fn event_name_matches_the_old_hardcoded_table() {
        // Golden test pinning behaviour-equivalence with the hardcoded match
        // this transform replaced: every method the sidecar actually emits must
        // map to the exact same Tauri event the old table produced.
        for (method, expected) in [
            ("chat/event", "claude:event"),
            ("chat/done", "claude:done"),
            ("chat/error", "claude:error"),
            ("chat/task", "claude:task"),
            ("chat/proposal", "claude:proposal"),
            ("chat/edit-pending", "claude:edit-pending"),
            ("chat/skill-pending", "claude:skill-pending"),
            ("chat/move-note", "claude:move-note"),
            ("chat/permission", "claude:permission"),
            ("ingest/result", "ingest:result"),
        ] {
            assert_eq!(notification_event_name(method).as_deref(), Some(expected));
        }
    }

    #[test]
    fn event_name_forwards_new_channels_and_drops_non_namespaced() {
        // A brand-new namespaced channel flows through with no bridge edit...
        assert_eq!(notification_event_name("chat/whatever").as_deref(), Some("claude:whatever"));
        assert_eq!(notification_event_name("profile/result").as_deref(), Some("profile:result"));
        // ...while a malformed, non-namespaced method is dropped (logged), not
        // forwarded as a bare event.
        assert_eq!(notification_event_name("shutdown"), None);
    }
}
