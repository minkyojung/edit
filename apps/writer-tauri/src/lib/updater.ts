// Thin invoke wrappers over the Rust-owned update state machine
// (src-tauri/src/updater.rs). All logic — checking, downloading, progress,
// error handling, the hourly loop — lives in Rust now; this module is just
// the typed frontend surface. State arrives via the `updater:state` event
// (see src/hooks/useUpdaterEvents.ts), NOT from these calls' return values.

import { invoke } from '@tauri-apps/api/core'

/** Mirror of the Rust `UpdateState` enum (serde tag = "status"). Auto-
 * download: there is no "available" step — a found update downloads +
 * installs in the background, so the user-facing states are checking →
 * (downloading) → ready. */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate'; checkedAt: number }
  | {
      status: 'downloading'
      version: string
      downloaded: number
      total: number | null
      percent: number | null
    }
  | { status: 'ready'; version: string; notes?: string }
  | {
      status: 'error'
      phase: 'check' | 'download' | 'install'
      message: string
      /** Manual failures toast; scheduled (boot/hourly) failures stay silent. */
      origin: 'manual' | 'scheduled'
    }
  | { status: 'unsupported'; reason: string }

/** The event every window listens on for state transitions. */
export const UPDATER_EVENT = 'updater:state'

export const updater = {
  /** Check → auto-download → install (one flow). The menu item, the About
   * "Check now" button, and the hourly loop all call this. Emits
   * checking → upToDate | downloading → ready | error. */
  check: () => invoke<void>('updater_check'),
  /** Relaunch into the installed version (the "Restart to update" action). */
  install: () => invoke<void>('updater_install'),
  /** Current state snapshot — for a window that mounts after the last
   * broadcast. */
  status: () => invoke<UpdateState>('updater_status'),
}
