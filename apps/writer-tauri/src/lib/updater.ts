// Thin invoke wrappers over the Rust-owned update state machine
// (src-tauri/src/updater.rs). All logic — checking, downloading, progress,
// error handling, the hourly loop — lives in Rust now; this module is just
// the typed frontend surface. State arrives via the `updater:state` event
// (see src/hooks/useUpdaterEvents.ts), NOT from these calls' return values.

import { invoke } from '@tauri-apps/api/core'

/** Mirror of the Rust `UpdateState` enum (serde tag = "status"). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate'; checkedAt: number }
  | { status: 'available'; version: string; notes?: string }
  | {
      status: 'downloading'
      version: string
      downloaded: number
      total: number | null
      percent: number | null
    }
  | { status: 'ready'; version: string }
  | { status: 'error'; phase: 'check' | 'download' | 'install'; message: string }
  | { status: 'unsupported'; reason: string }

/** The event every window listens on for state transitions. */
export const UPDATER_EVENT = 'updater:state'

export const updater = {
  /** Check for a newer version (manual trigger — the menu item and the
   * hourly loop call the same Rust flow). Emits checking → upToDate |
   * available | error. */
  check: () => invoke<void>('updater_check'),
  /** Download + install the staged update (the "Download" action). Emits
   * downloading → ready | error. */
  download: () => invoke<void>('updater_download'),
  /** Relaunch into the installed version (the "Restart now" action). */
  install: () => invoke<void>('updater_install'),
  /** Current state snapshot — for a window that mounts after the last
   * broadcast. */
  status: () => invoke<UpdateState>('updater_status'),
}
