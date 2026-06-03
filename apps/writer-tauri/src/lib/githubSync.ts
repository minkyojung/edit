// Periodic GitHub activity sync. The poll loop lives in the frontend
// because the rust backend doesn't know the active vault path — the
// timer calls the rust `github_sync` command with the vault + ingest
// time, and rust does the token/HTTP/events.db work. Mirrors the
// idempotent-timer shape of docFileSync's startAutoFlush.

import { invoke } from '@tauri-apps/api/core'
import { getActiveVaultPath } from '@/state/settingsStore'

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 min
let timerId: number | null = null
let inFlight = false

/** Run one sync now. No-ops without an active vault (so it's safe before
 * onboarding), guards against overlapping runs, and swallows errors —
 * GitHub being down just means the next tick retries. Rust returns Ok(0)
 * when not connected, so this is also safe to call unconditionally. */
export async function syncGitHubActivity(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  if (inFlight) return
  inFlight = true
  try {
    await invoke<number>('github_sync', {
      vaultPath: vault,
      ingestedAt: new Date().toISOString(),
    })
  } catch (e) {
    console.warn('[githubSync] sync failed', e)
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
