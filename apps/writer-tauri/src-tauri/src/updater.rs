// Backend-owned, observable auto-update state machine.
//
// The authority for update checking/downloading/installing lives here in
// Rust, not in a webview: one process-wide state machine drives the whole
// flow and broadcasts a single `updater:state` event to EVERY window. The
// frontend is a pure renderer (see src/hooks/useUpdaterEvents.ts) plus a
// manual trigger (the About settings row + the "Check for Updates…" menu
// item). Errors are a first-class state — never swallowed — which is the
// core fix for the prior JS updater that hid every failure in console.warn
// and only surfaced a toast after a successful install.
//
// Flow is auto-download (VS Code / Slack / Notion convention): a check that
// finds a newer version downloads + installs it silently in the background,
// then emits `ready`. The only user-facing moment is a single "restart to
// update" prompt; a staged install applies on the next relaunch regardless,
// so ignoring the prompt is safe (it lands next time the app is quit +
// reopened). No "click to download" step, no progress prompt — download
// progress is deliberately not surfaced anywhere prominent (the About row
// may show it, but there is no toast/main-window indicator).
//
// Two policies borrowed from Sparkle / VS Code:
// - Errors carry the check's origin (manual vs scheduled): the frontend
//   toasts only manual failures; scheduled background failures stay silent
//   (state/About row only).
// - A staged `ready` update is never demoted. Later checks still run, but
//   any outcome that isn't "newer version to download" (check error,
//   up-to-date, failed supersede) re-emits `Ready` for the staged version —
//   the staged bundle still applies on relaunch, so reporting an error or
//   "up to date" over it would lie to the user.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// The single event name every window listens on.
const EVENT: &str = "updater:state";
/// Progress emits are throttled to at most one per this interval (plus one
/// whenever the integer percent changes) so a fast download doesn't flood
/// the event channel / re-render loop.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);

/// Who asked for this check. Manual (menu item / About "Check now") failures
/// toast; scheduled (boot + hourly loop) failures are silent to the user —
/// the Sparkle checkForUpdates vs checkForUpdatesInBackground split.
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckOrigin {
    Manual,
    /// Only constructed by the release-only boot+hourly loop in lib.rs
    /// (`#[cfg(not(debug_assertions))]`), so dev builds see it as dead.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Scheduled,
}

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
    /// Auto-downloading in the background. Not surfaced as a toast; the
    /// About row may render it. `total`/`percent` are null when the server
    /// omits content-length (indeterminate).
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
        percent: Option<u8>,
    },
    /// Downloaded + installed; a relaunch applies it (and it applies on the
    /// next natural relaunch even if the user ignores the prompt). `notes` is
    /// the incoming version's release notes from the update manifest, for the
    /// toast's "See changes".
    Ready {
        version: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
    },
    /// A failure at a named phase. `message` is already human-readable.
    /// `origin` lets the frontend toast only manual-check failures.
    Error {
        phase: &'static str,
        message: String,
        origin: CheckOrigin,
    },
    /// Dev build — the updater is intentionally disabled (no bundle to
    /// replace, no release to find).
    Unsupported { reason: String },
}

#[derive(Default)]
struct Inner {
    /// A check/download is running — reject re-entry so a menu click,
    /// settings click, or loop tick can't overlap the in-flight work.
    busy: bool,
    /// Last emitted state, handed to windows that mount their listener
    /// after the last broadcast (via `updater_status`).
    last: Option<UpdateState>,
    /// Version currently staged as `ready` — lets a later check short-
    /// circuit instead of re-downloading the same bundle.
    ready_version: Option<String>,
    /// Release notes of the staged version, re-emitted on the short-circuit.
    ready_notes: Option<String>,
    /// Armed by the update-ready toast's "Restart when idle". Process-global
    /// so it survives closing the window that armed it — the old JS poller
    /// died with its webview. Read by the idle-restart loop below.
    armed_restart: bool,
    /// A window vetoed the pending restart (in-flight chat / unsaved edits).
    /// Set by `updater_restart_veto`, reset before each probe by the loop.
    restart_vetoed: bool,
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
/// A poisoned lock is treated as busy (no-op) — same tolerance as the
/// other lock sites.
fn try_begin(app: &AppHandle) -> bool {
    match app.try_state::<UpdaterState>() {
        Some(s) => {
            if let Ok(mut inner) = s.inner.lock() {
                if inner.busy {
                    false
                } else {
                    inner.busy = true;
                    true
                }
            } else {
                false
            }
        }
        None => false,
    }
}

/// Releases the busy flag on drop — even if `do_run` panics, so a single
/// bad check can't leave `busy` stuck and silently disable every future
/// check for the rest of the process.
struct BusyGuard(AppHandle);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Some(s) = self.0.try_state::<UpdaterState>() {
            if let Ok(mut inner) = s.inner.lock() {
                inner.busy = false;
            }
        }
    }
}

fn ready_version(app: &AppHandle) -> Option<String> {
    app.try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().ok().and_then(|i| i.ready_version.clone()))
}

fn ready_notes(app: &AppHandle) -> Option<String> {
    app.try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().ok().and_then(|i| i.ready_notes.clone()))
}

/// If an update is staged (`ready`), re-emit `Ready` for it instead of
/// demoting to `Error` — the staged bundle still applies on relaunch, so a
/// later failed check doesn't invalidate it (Sparkle behavior). The real
/// error goes to stderr for observability. Emits `Error` only when nothing
/// is staged.
fn fail_or_keep_staged(app: &AppHandle, origin: CheckOrigin, phase: &'static str, message: String) {
    if let Some(version) = ready_version(app) {
        eprintln!("[updater] {phase} failed while v{version} is staged (kept ready): {message}");
        set_state(app, UpdateState::Ready { version, notes: ready_notes(app) });
    } else {
        set_state(app, UpdateState::Error { phase, message, origin });
    }
}

/// Check for an update and, if one exists, download + install it in the
/// background (auto-download). Emits `checking` → `upToDate` | `downloading`
/// → `ready` | `error{check|download|install}`. No-ops if already busy or a
/// dev build. Called by the startup loop, the menu item, and the About
/// "Check now" button — all the same flow, distinguished only by `origin`.
pub async fn run_check(app: AppHandle, origin: CheckOrigin) {
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
    let _busy = BusyGuard(app.clone());
    do_run(&app, origin).await;
}

async fn do_run(app: &AppHandle, origin: CheckOrigin) {
    set_state(app, UpdateState::Checking);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            fail_or_keep_staged(app, origin, "check", e.to_string());
            return;
        }
    };

    let update = match updater.check().await {
        Ok(None) => {
            // With an update staged, "no update found" doesn't un-stage it —
            // the bundle still applies on relaunch, so keep Ready.
            if let Some(version) = ready_version(app) {
                set_state(app, UpdateState::Ready { version, notes: ready_notes(app) });
            } else {
                set_state(app, UpdateState::UpToDate { checked_at: now_ms() });
            }
            return;
        }
        Ok(Some(u)) => u,
        Err(e) => {
            fail_or_keep_staged(app, origin, "check", e.to_string());
            return;
        }
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    // Already downloaded + staged this exact version — keep Ready instead of
    // re-downloading the same bundle (e.g. a later check after the user
    // ignored the restart prompt). A DIFFERENT version falls through and
    // supersedes the staged one (download + install below).
    if ready_version(app).as_deref() == Some(version.as_str()) {
        set_state(app, UpdateState::Ready { version, notes: ready_notes(app) });
        return;
    }

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
            // A failed supersede keeps the previously staged version Ready
            // (its bundle still applies on relaunch).
            fail_or_keep_staged(app, origin, "download", e.to_string());
            return;
        }
    };

    // Install is a distinct phase: a failure here is almost always the app
    // running from a read-only / quarantined location (the exact silent bug
    // this rewrite fixes — now surfaced with a fix hint). `install()` is
    // synchronous blocking file I/O, so run it off the async runtime.
    let installed = match tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await
    {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match installed {
        Ok(()) => {
            if let Some(s) = app.try_state::<UpdaterState>() {
                if let Ok(mut inner) = s.inner.lock() {
                    inner.ready_version = Some(version.clone());
                    inner.ready_notes = notes.clone();
                }
            }
            set_state(app, UpdateState::Ready { version, notes });
        }
        Err(e) => fail_or_keep_staged(app, origin, "install", e),
    }
}

// ── Restart when idle ─────────────────────────────────────────────
//
// A staged `ready` update applies on the next natural quit regardless, so this
// is a convenience: relaunch during a lull instead of making the user quit.
// The authority lives here in Rust — a process-global armed flag plus a tokio
// loop reading the NATIVE system idle time — because the prior JS poller had
// two structural defects: its webview `setInterval` was throttled by App Nap
// exactly when the app went idle (the moment it needed to fire), and its armed
// state lived in one window's memory, so closing that window silently lost it.

// The loop that consumes these is release-only (spawned under
// `not(debug_assertions)` in lib.rs), so debug builds see them as dead — same
// convention as `CheckOrigin::Scheduled`.
/// System must be idle at least this long before an armed restart fires.
#[cfg_attr(debug_assertions, allow(dead_code))]
const RESTART_IDLE_SECS: f64 = 45.0;
/// Idle-restart loop poll cadence.
#[cfg_attr(debug_assertions, allow(dead_code))]
const RESTART_POLL: Duration = Duration::from_secs(5);
/// After the system is idle, windows get this long to veto — all local IPC,
/// so 500ms is generous.
#[cfg_attr(debug_assertions, allow(dead_code))]
const RESTART_VETO_WINDOW: Duration = Duration::from_millis(500);
/// Event asking every window "safe to restart?" — a busy window replies by
/// calling `updater_restart_veto`.
#[cfg_attr(debug_assertions, allow(dead_code))]
const CONFIRM_RESTART_EVENT: &str = "updater:confirm-restart";

/// Seconds since the last system-wide HID input (keyboard / mouse / trackpad),
/// read from Core Graphics — the same source Sparkle uses. Runs in Rust, so
/// it's immune to the App Nap / WKWebView timer throttling that stalled the old
/// JS idle poller precisely when the app went idle.
#[cfg(target_os = "macos")]
#[cfg_attr(debug_assertions, allow(dead_code))]
fn system_idle_secs() -> f64 {
    // CFTimeInterval CGEventSourceSecondsSinceLastEventType(
    //     CGEventSourceStateID source, CGEventType eventType);
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateHIDSystemState = 1, kCGAnyInputEventType = ~0.
    unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) }
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn armed_restart(app: &AppHandle) -> bool {
    app.try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().ok().map(|i| i.armed_restart))
        .unwrap_or(false)
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn restart_vetoed(app: &AppHandle) -> bool {
    app.try_state::<UpdaterState>()
        .and_then(|s| s.inner.lock().ok().map(|i| i.restart_vetoed))
        .unwrap_or(false)
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn set_restart_vetoed(app: &AppHandle, vetoed: bool) {
    if let Some(s) = app.try_state::<UpdaterState>() {
        if let Ok(mut i) = s.inner.lock() {
            i.restart_vetoed = vetoed;
        }
    }
}

/// Once armed, wait for the system to go idle, confirm no window has in-flight
/// work, then relaunch into the staged update. Spawned once from lib.rs on
/// release + macOS. A veto (or the system becoming active again) just defers to
/// the next lull — the arm stays set until it fires or the app quits.
#[cfg(target_os = "macos")]
#[cfg_attr(debug_assertions, allow(dead_code))]
pub async fn run_idle_restart_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(RESTART_POLL).await;
        if !armed_restart(&app) {
            continue;
        }
        if system_idle_secs() < RESTART_IDLE_SECS {
            continue;
        }
        // Idle long enough. Ask every window whether it's safe; a window with a
        // streaming chat or unsaved edits vetoes, and we wait for the next lull.
        set_restart_vetoed(&app, false);
        let _ = app.emit(CONFIRM_RESTART_EVENT, ());
        tokio::time::sleep(RESTART_VETO_WINDOW).await;
        if restart_vetoed(&app) {
            continue;
        }
        app.restart();
    }
}

// ── Commands ──────────────────────────────────────────────────────

/// Manual/scheduled check → auto-download → install. Drives `run_check`;
/// errors surface as state, so the command itself only returns Err for the
/// (rare) inability to start.
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<(), String> {
    run_check(app, CheckOrigin::Manual).await;
    Ok(())
}

/// Relaunch into the freshly-installed version (the "Restart to update"
/// action). Only meaningful when the state is `ready`. `restart()` never
/// returns.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    app.restart();
}

/// Arm "restart when idle" (the update-ready toast action). Idempotent — the
/// process-global idle-restart loop does the rest.
#[tauri::command]
pub fn updater_arm_restart_when_idle(state: tauri::State<'_, UpdaterState>) {
    if let Ok(mut i) = state.inner.lock() {
        i.armed_restart = true;
    }
}

/// A window's reply to the pre-restart probe: it has in-flight work (streaming
/// chat / unsaved edits), so defer. Reset before each probe by the loop.
#[tauri::command]
pub fn updater_restart_veto(state: tauri::State<'_, UpdaterState>) {
    if let Ok(mut i) = state.inner.lock() {
        i.restart_vetoed = true;
    }
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
