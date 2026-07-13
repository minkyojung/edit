// Backend-owned, observable auto-update state machine.
//
// The authority for update checking/downloading/installing lives here in
// Rust, not in a webview: one process-wide state machine drives the whole
// flow and broadcasts a single `updater:state` event to EVERY window. The
// frontend is a pure renderer (see src/hooks/useUpdaterEvents.ts) plus
// manual triggers (the About settings row + the "Check for Updates…" menu
// item). Errors are a first-class state — never swallowed — which is the
// core fix for the prior JS updater that hid every failure in console.warn
// and only surfaced a toast after a successful install.
//
// Flow is notify-first (Sparkle/Electron convention): a check that finds a
// newer version emits `available` and stops; the user clicks Download
// (emits `downloading` with throttled progress) then Restart (relaunch).
// The `Update` handle returned by check() is parked in `pending` between
// the check and the download command — the reason this state is stateful.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The single event name every window listens on.
const EVENT: &str = "updater:state";
/// Progress emits are throttled to at most one per this interval (plus one
/// whenever the integer percent changes) so a fast download doesn't flood
/// the event channel / re-render loop.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);

/// The observable state, mirrored 1:1 by the TS `UpdateState` union. Tagged
/// on `status` so the frontend store is a trivial last-write-wins replace.
#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateState {
    /// Nothing has happened yet this process.
    Idle,
    /// A check is in flight.
    Checking,
    /// Check completed; already on the newest version.
    UpToDate { checked_at: u64 },
    /// A newer version exists. The `Update` handle is parked in `pending`
    /// awaiting the user's Download action (notify-first).
    Available {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    /// Download in progress. `total`/`percent` are null when the server
    /// omits content-length (indeterminate progress).
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
        percent: Option<u8>,
    },
    /// Downloaded + installed; a relaunch will apply it.
    Ready { version: String },
    /// A failure at a named phase. `message` is already human-readable.
    Error { phase: &'static str, message: String },
    /// Dev build — the updater is intentionally disabled (no bundle to
    /// replace, no release to find).
    Unsupported { reason: String },
}

#[derive(Default)]
struct Inner {
    /// A check or download is running — reject re-entry so a menu click,
    /// settings click, or loop tick can't overlap the in-flight work.
    busy: bool,
    /// Last emitted state, handed to windows that mount their listener
    /// after the last broadcast (via `updater_status`).
    last: Option<UpdateState>,
    /// The handle from the most recent successful check, awaiting Download.
    pending: Option<Update>,
    /// Version currently staged as `ready` — lets a later check short-
    /// circuit instead of re-downloading the same bundle.
    ready_version: Option<String>,
}

/// Managed via `.manage(UpdaterState::default())` in lib.rs.
#[derive(Default)]
pub struct UpdaterState {
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Emit `state` to every window and remember it as `last`. The ONLY place
/// the event is emitted — every transition funnels through here.
fn set_state(app: &AppHandle, state: UpdateState) {
    if let Some(s) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = s.inner.lock() {
            inner.last = Some(state.clone());
        }
    }
    let _ = app.emit(EVENT, &state);
}

/// Claim the busy flag. Returns false (caller no-ops) if already busy.
fn try_begin(app: &AppHandle) -> bool {
    match app.try_state::<UpdaterState>() {
        Some(s) => {
            let mut inner = s.inner.lock().unwrap();
            if inner.busy {
                false
            } else {
                inner.busy = true;
                true
            }
        }
        None => false,
    }
}

/// Release the busy flag. Must run on every exit path of a claimed flow.
fn end(app: &AppHandle) {
    if let Some(s) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = s.inner.lock() {
            inner.busy = false;
        }
    }
}

/// Check for an update. Emits `checking` → `upToDate` | `available` |
/// `error{check}`. No-ops if already busy or a dev build.
pub async fn run_check(app: AppHandle) {
    if cfg!(debug_assertions) {
        set_state(
            &app,
            UpdateState::Unsupported {
                reason: "Development build — updates are disabled.".into(),
            },
        );
        return;
    }
    if !try_begin(&app) {
        return;
    }
    do_check(&app).await;
    end(&app);
}

async fn do_check(app: &AppHandle) {
    set_state(app, UpdateState::Checking);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            set_state(
                app,
                UpdateState::Error {
                    phase: "check",
                    message: e.to_string(),
                },
            );
            return;
        }
    };

    match updater.check().await {
        Ok(None) => set_state(app, UpdateState::UpToDate { checked_at: now_ms() }),
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            // Already downloaded + staged this exact version — keep Ready
            // instead of re-offering a download.
            let already_ready = app
                .try_state::<UpdaterState>()
                .and_then(|s| s.inner.lock().ok().and_then(|i| i.ready_version.clone()))
                .map(|v| v == version)
                .unwrap_or(false);
            if already_ready {
                set_state(app, UpdateState::Ready { version });
                return;
            }
            if let Some(s) = app.try_state::<UpdaterState>() {
                if let Ok(mut inner) = s.inner.lock() {
                    inner.pending = Some(update);
                }
            }
            set_state(app, UpdateState::Available { version, notes });
        }
        Err(e) => set_state(
            app,
            UpdateState::Error {
                phase: "check",
                message: e.to_string(),
            },
        ),
    }
}

/// Download + install the update parked by the last check. Emits
/// `downloading` (throttled) → `ready` | `error{download|install}`.
/// No-ops if already busy, a dev build, or nothing is staged.
pub async fn run_download(app: AppHandle) {
    if cfg!(debug_assertions) {
        set_state(
            &app,
            UpdateState::Unsupported {
                reason: "Development build — updates are disabled.".into(),
            },
        );
        return;
    }
    if !try_begin(&app) {
        return;
    }
    do_download(&app).await;
    end(&app);
}

async fn do_download(app: &AppHandle) {
    // Clone the handle out (Update: Clone) so we don't hold the lock across
    // the await; keep `pending` populated so a failed download can retry.
    let update = app
        .try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().ok().and_then(|i| i.pending.clone()));
    let update = match update {
        Some(u) => u,
        None => {
            set_state(
                app,
                UpdateState::Error {
                    phase: "download",
                    message: "No update is staged — run a check first.".into(),
                },
            );
            return;
        }
    };

    let version = update.version.clone();
    set_state(
        app,
        UpdateState::Downloading {
            version: version.clone(),
            downloaded: 0,
            total: None,
            percent: None,
        },
    );

    // Throttled progress reporter. Owns its running counters (FnMut).
    let app_progress = app.clone();
    let ver_progress = version.clone();
    let mut downloaded: u64 = 0;
    let mut total: Option<u64> = None;
    let mut last_emit = Instant::now();
    let mut last_pct: i32 = -1;

    let bytes = update
        .download(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                if total.is_none() {
                    total = content_len;
                }
                let percent = total.and_then(|t| {
                    if t > 0 {
                        Some(((downloaded * 100 / t) as u8).min(100))
                    } else {
                        None
                    }
                });
                let crossed = percent.map(|p| p as i32 != last_pct).unwrap_or(false);
                if last_emit.elapsed() >= PROGRESS_THROTTLE || crossed {
                    last_emit = Instant::now();
                    last_pct = percent.map(|p| p as i32).unwrap_or(-1);
                    set_state(
                        &app_progress,
                        UpdateState::Downloading {
                            version: ver_progress.clone(),
                            downloaded,
                            total,
                            percent,
                        },
                    );
                }
            },
            || {},
        )
        .await;

    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            set_state(
                app,
                UpdateState::Error {
                    phase: "download",
                    message: e.to_string(),
                },
            );
            return;
        }
    };

    // Install is a distinct phase: a failure here is almost always the
    // app running from a read-only / quarantined location (the exact
    // silent bug this rewrite fixes — now surfaced with a fix hint).
    match update.install(bytes) {
        Ok(()) => {
            if let Some(s) = app.try_state::<UpdaterState>() {
                if let Ok(mut inner) = s.inner.lock() {
                    inner.ready_version = Some(version.clone());
                    inner.pending = None;
                }
            }
            set_state(app, UpdateState::Ready { version });
        }
        Err(e) => set_state(
            app,
            UpdateState::Error {
                phase: "install",
                message: e.to_string(),
            },
        ),
    }
}

// ── Commands ──────────────────────────────────────────────────────

/// Manual/scheduled check. Drives `run_check`; errors surface as state, so
/// the command itself only returns Err for the (rare) inability to start.
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<(), String> {
    run_check(app).await;
    Ok(())
}

/// Download + install the staged update (the "Download" action).
#[tauri::command]
pub async fn updater_download(app: AppHandle) -> Result<(), String> {
    run_download(app).await;
    Ok(())
}

/// Relaunch into the freshly-installed version (the "Restart now" action).
/// Only meaningful when the state is `ready`. `restart()` never returns.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    app.restart();
}

/// Snapshot of the current state for a window that mounts its listener
/// after the last broadcast.
#[tauri::command]
pub fn updater_status(state: tauri::State<'_, UpdaterState>) -> UpdateState {
    state
        .inner
        .lock()
        .ok()
        .and_then(|i| i.last.clone())
        .unwrap_or(UpdateState::Idle)
}
