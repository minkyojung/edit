// Periodic GitHub activity sync. The poll loop lives in the frontend so it
// can gate on an active vault (don't sync before onboarding); the timer calls
// the rust `github_sync` command with just the ingest time, and rust does the
// token/HTTP work + writes the per-device app-data `events.db`. Mirrors the
// idempotent-timer shape of docFileSync's startAutoFlush.

import { invoke } from '@tauri-apps/api/core'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useEventsStore } from '@/state/eventsStore'

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 min
let timerId: number | null = null
let inFlight = false

/** Run one sync now. No-ops without an active vault (so it's safe before
 * onboarding), guards against overlapping runs, and swallows errors —
 * GitHub being down just means the next tick retries. Rust returns Ok(0)
 * when not connected, so this is also safe to call unconditionally.
 *
 * Returns true on a completed sync, false if it was skipped (no vault /
 * already running) or failed — the manual refresh button uses this for
 * toast feedback; the fire-and-forget callers ignore it. */
export async function syncGitHubActivity(): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) return false
  if (inFlight) return false
  inFlight = true
  try {
    const upserted = await invoke<number>('github_sync', {
      ingestedAt: new Date().toISOString(),
    })
    // Nudge any open activity cards to re-query events.db.
    if (upserted > 0) useEventsStore.getState().bump()
    return true
  } catch (e) {
    console.warn('[githubSync] sync failed', e)
    return false
  } finally {
    inFlight = false
  }
}

/** Start the periodic sync. Idempotent (safe under StrictMode double
 * mount). The launch-time and connect-time immediate syncs are fired by
 * their own call sites (BootGate, the connect dialog). */
export function startGitHubSync(): void {
  if (timerId !== null) return
  timerId = window.setInterval(() => {
    void syncGitHubActivity()
  }, SYNC_INTERVAL_MS)
}

export function stopGitHubSync(): void {
  if (timerId === null) return
  window.clearInterval(timerId)
  timerId = null
}
