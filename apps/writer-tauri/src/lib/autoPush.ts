// Auto-push (Track B slice 2). After each commit lands — observed via the
// gitStore `headSha` changing, which every commit path updates (normal
// commits AND reverts) — push the vault to its bound backup repo. Debounced
// to coalesce bursts, single-flight, and silently retried when offline.
//
// No retry queue: git push is idempotent (it sends everything ahead of the
// remote), so "is there anything to push?" reduces to HEAD != lastPushedSha,
// and "retry" means "call pushNow again later". Success is silent; only an
// auth/scope failure surfaces a toast. Mirrors githubSync.ts's timer shape.

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useSyncStore } from '@/state/syncStore'
import { useGitStore } from '@/state/gitStore'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'

const DEBOUNCE_MS = 4000
const RETRY_INTERVAL_MS = 60 * 1000

let inFlight = false
let rerun = false
let debounceId: number | null = null
let retryId: number | null = null
let unsubscribe: (() => void) | null = null

/** Auth/scope failures we should surface (and stop retrying) vs transient
 * ones (offline) we retry silently. */
function isAuthError(msg: string): boolean {
  return /reconnect|denied|scope|repo\) access/i.test(msg)
}

/** Push the vault now if a backup is bound and there's anything unpushed.
 * Idempotent + single-flight; safe to call from timers, the headSha
 * subscription, or boot. Silent on success; offline failures go to
 * `pending` and are retried, auth failures surface a reconnect prompt. */
export async function pushNow(): Promise<void> {
  const sync = useSyncStore.getState()
  // 1. Not backed up yet → the feature is off until the first manual backup.
  if (!sync.repoFullName) return
  // 2. Single-flight: fold a concurrent request into one trailing re-run.
  if (inFlight) {
    rerun = true
    return
  }
  // 3. Nothing new since the last successful push.
  const head = useGitStore.getState().headSha
  if (!head || head === sync.lastPushedSha) return

  const vault = getActiveVaultPath()
  if (!vault) return

  inFlight = true
  useSyncStore.getState().setPushing()
  try {
    await invoke('vault_push', { vaultPath: vault })
    // Re-read HEAD — more commits may have landed during the push.
    useSyncStore.getState().setPushed(useGitStore.getState().headSha)
  } catch (e) {
    const msg = String(e)
    if (isAuthError(msg)) {
      const wasError = useSyncStore.getState().status === 'error'
      useSyncStore.getState().setError(msg)
      // Surface once — don't re-toast on every subsequent commit.
      if (!wasError) {
        toast.error('Reconnect GitHub to keep backing up.', {
          action: {
            label: 'Reconnect',
            onClick: () => useConnectGitHubDialog.getState().setOpen(true),
          },
        })
      }
    } else {
      // Transient (offline, etc.) — silent; the retry timer picks it up.
      useSyncStore.getState().setPending(msg)
    }
  } finally {
    inFlight = false
    if (rerun) {
      rerun = false
      void pushNow()
    }
  }
}

/** Start auto-push: debounced push on every HEAD advance + a periodic retry
 * for the offline/pending case. Idempotent (safe under StrictMode double
 * mount). Boot catch-up is automatic — the first refreshActivity moves
 * headSha off null, which the subscription treats as a change. */
export function startAutoPush(): void {
  if (unsubscribe) return
  unsubscribe = useGitStore.subscribe((state, prev) => {
    if (state.headSha === prev.headSha) return
    if (debounceId !== null) window.clearTimeout(debounceId)
    debounceId = window.setTimeout(() => {
      debounceId = null
      void pushNow()
    }, DEBOUNCE_MS)
  })
  retryId = window.setInterval(() => {
    if (useSyncStore.getState().status === 'pending') void pushNow()
  }, RETRY_INTERVAL_MS)
}

export function stopAutoPush(): void {
  if (debounceId !== null) {
    window.clearTimeout(debounceId)
    debounceId = null
  }
  if (retryId !== null) {
    window.clearInterval(retryId)
    retryId = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}
