// "Restart when idle" — apply a staged update at the next safe moment instead
// of interrupting the user (the Conductor pattern). Rust owns the arming and
// the idle detection now (a process-global loop reading the native macOS system
// idle time, see src-tauri/src/updater.rs): it survives closing the window that
// armed it, and it isn't subject to the webview timer throttling that stalled
// the old JS poller exactly when the app went idle — the moment it needed to
// fire. This module is the thin webview half: arm the Rust loop, and answer its
// "safe to restart?" probe with the one signal Rust can't see — this window's
// in-flight work.
//
// If the app is quit before it ever goes idle, the staged install applies on
// the next launch anyway — so arming is always safe; worst case is "applies a
// bit later" rather than "never".

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useChatRuns } from '@/stores/chatRuns'
import { getDirtySlugs } from '@/lib/docFileSync'

/** Rust emits this once the system has been idle long enough; a window with
 * in-flight work replies by vetoing (see {@link listenForRestartProbe}). */
const CONFIRM_RESTART_EVENT = 'updater:confirm-restart'

/** True when restarting now won't disrupt THIS window: no in-flight chat run
 * (a stream would be cut off) and no unsaved edits (a dirty doc hasn't flushed
 * to disk yet). The idle-time gate lives in Rust now. Pure given the module
 * signals — exported for reasoning/tests. */
export function canRestartNow(): boolean {
  if (useChatRuns.getState().runs.size > 0) return false
  if (getDirtySlugs().length > 0) return false
  return true
}

/** Arm "restart when idle": hand off to the Rust idle-restart loop, which
 * relaunches into the staged update once the system is idle and no window
 * vetoes. Idempotent (arming twice is a no-op in Rust). */
export function armRestartWhenIdle(): void {
  void invoke('updater_arm_restart_when_idle')
}

/** Subscribe this window to Rust's pre-restart probe: when the system is idle
 * and a restart is armed, Rust asks every window whether it's safe; a window
 * with in-flight work vetoes so the loop waits for the next lull. Mounted once
 * per window (from useUpdaterEvents). Returns an unlisten fn. */
export function listenForRestartProbe(): Promise<UnlistenFn> {
  return listen(CONFIRM_RESTART_EVENT, () => {
    if (!canRestartNow()) void invoke('updater_restart_veto')
  })
}
