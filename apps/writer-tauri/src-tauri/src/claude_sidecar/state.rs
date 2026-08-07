// Observable state machine for the sidecar supervisor.
//
// Mirrors the pattern proven by `updater.rs`: the backend owns the state,
// funnels every transition through a single emit (`set_sidecar_state`), retains
// the last value per mode, and exposes a snapshot command (`sidecar_status`) so
// a window that mounts its listener *after* the last broadcast can still learn
// the current state. The frontend is a pure renderer.
//
// This closes the gap the prior fire-and-forget `sidecar:died` event left: a
// window opened after a sidecar died had no way to discover it, and there was
// no observable "running / restarting / recovered" state for consumers to read
// — each had to infer death on its own.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The single event carrying every sidecar-supervisor transition. One name, one
/// emitter (`set_sidecar_state`).
pub const SIDECAR_STATE_EVENT: &str = "sidecar:state";

/// Observable lifecycle of one sidecar process. Tagged on `status` so the
/// frontend store is a trivial
/// last-write-wins replace; `mode` (`chat` | `title`) identifies which sidecar,
/// since the two run and fail independently.
///
/// This used to claim it was "mirrored 1:1 by the TS `SidecarState` union".
/// There is no such union — both consumers read an inline `{status, mode}`
/// (agent/chat/index.ts, agent/chatRun.ts) and never look at `attempt`, `max`,
/// or `fatal`. The shape below is pinned by the test at the bottom of this
/// file; the TS side is not, so a variant added here reaches no one.
/// `CommandError` in commands.rs is the same pattern done the other way, with
/// an exhaustive TS union — copy that if this ever grows a real consumer.
#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SidecarState {
    /// Spawning the initial process; not yet ready.
    Starting { mode: String },
    /// Initialized and accepting requests.
    Running { mode: String },
    /// Died and is being respawned after a backoff. `attempt` is the
    /// consecutive-fast-death count so far; `max` the cap before we give up.
    Restarting { mode: String, attempt: u32, max: u32 },
    /// Terminal: crash-looped past the cap, or the respawn itself failed.
    /// `fatal` mirrors the prior `sidecar:died { fatal }` payload consumers read.
    Dead { mode: String, fatal: bool },
}

impl SidecarState {
    fn mode(&self) -> &str {
        match self {
            SidecarState::Starting { mode }
            | SidecarState::Running { mode }
            | SidecarState::Restarting { mode, .. }
            | SidecarState::Dead { mode, .. } => mode,
        }
    }
}

/// Managed via `.manage(SidecarSupervisorState::default())` in lib.rs. Holds the
/// last state per mode so `sidecar_status` can replay it to a late-mounting
/// window.
#[derive(Default)]
pub struct SidecarSupervisorState {
    last: Mutex<HashMap<String, SidecarState>>,
}

/// Emit `state` to every window and remember it as the last state for its mode.
/// The ONLY place `sidecar:state` is emitted — every transition funnels here.
pub fn set_sidecar_state(app: &AppHandle, state: SidecarState) {
    if let Some(s) = app.try_state::<SidecarSupervisorState>() {
        if let Ok(mut last) = s.last.lock() {
            last.insert(state.mode().to_string(), state.clone());
        }
    }
    let _ = app.emit(SIDECAR_STATE_EVENT, &state);
}

/// Snapshot of the current state of every sidecar, keyed by mode
/// (`chat` | `title`), for a window that mounts its listener after the last
/// broadcast. Empty until the first transition is emitted.
#[tauri::command]
pub fn sidecar_status(
    state: tauri::State<'_, SidecarSupervisorState>,
) -> HashMap<String, SidecarState> {
    state.last.lock().map(|m| m.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Pins the wire contract the frontend `SidecarState` union depends on:
    // a flat object tagged on `status`, always carrying `mode`.
    #[test]
    fn serializes_flat_tagged_on_status_with_mode() {
        assert_eq!(
            serde_json::to_value(SidecarState::Starting { mode: "chat".into() }).unwrap(),
            json!({ "status": "starting", "mode": "chat" }),
        );
        assert_eq!(
            serde_json::to_value(SidecarState::Running { mode: "title".into() }).unwrap(),
            json!({ "status": "running", "mode": "title" }),
        );
        assert_eq!(
            serde_json::to_value(SidecarState::Restarting {
                mode: "chat".into(),
                attempt: 2,
                max: 5,
            })
            .unwrap(),
            json!({ "status": "restarting", "mode": "chat", "attempt": 2, "max": 5 }),
        );
        assert_eq!(
            serde_json::to_value(SidecarState::Dead { mode: "chat".into(), fatal: true }).unwrap(),
            json!({ "status": "dead", "mode": "chat", "fatal": true }),
        );
    }
}
