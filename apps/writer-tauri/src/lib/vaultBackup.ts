// Track B — first-backup action. Calls the rust `vault_backup_init`
// command (create private repo + push the vault), drives `syncStore`, and
// surfaces progress via toasts. The token never leaves rust; this layer
// only knows the vault path. Mirrors githubSync.ts's invoke-and-toast shape.

import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { toast } from 'sonner'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useSyncStore } from '@/state/syncStore'
import { useGitStore } from '@/state/gitStore'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'

interface SyncStateResult {
  repoFullName: string
  remoteUrl: string
  branch: string
  vaultId: string
  status: string
}

/** Run the first-backup flow. Guards against overlapping runs and no-vault,
 * and prompts a GitHub reconnect when the token lacks the `repo` scope.
 * Safe to call directly from a click handler. */
export async function backupToGitHub(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) {
    toast.error('Pick a vault folder first.')
    return
  }
  const store = useSyncStore.getState()
  if (store.status === 'backing-up') return
  store.setBackingUp()
  const id = toast.loading('Backing up to GitHub…')

  try {
    const state = await invoke<SyncStateResult>('vault_backup_init', {
      vaultPath: vault,
    })
    useSyncStore.getState().setConnected({
      repoFullName: state.repoFullName,
      remoteUrl: state.remoteUrl,
      branch: state.branch,
      vaultId: state.vaultId,
      lastPushedSha: useGitStore.getState().headSha,
    })
    // Everything up to HEAD is now pushed → the review feed (origin..HEAD)
    // clears.
    void useGitStore.getState().refreshActivity()
    toast.success(`Backed up to ${state.repoFullName}`, {
      id,
      action: {
        label: 'View',
        onClick: () => void openUrl(`https://github.com/${state.repoFullName}`),
      },
    })
  } catch (e) {
    const msg = String(e)
    useSyncStore.getState().setError(msg)
    // GitHub denies repo creation when the token predates the `repo` scope
    // (older connections) — offer a reconnect to grant it.
    if (/reconnect|denied|scope|repo\) access/i.test(msg)) {
      toast.error('Reconnect GitHub to allow backup.', {
        id,
        action: {
          label: 'Reconnect',
          onClick: () => useConnectGitHubDialog.getState().setOpen(true),
        },
      })
    } else {
      toast.error(`Backup failed: ${msg}`, { id })
    }
  }
}

let pushInFlight = false

/** Push the already-bound backup repo: upload commits made since the last
 * push. Used by the review panel's "Back up" button (fully manual — there
 * is no auto-push). No-ops when no backup is set up yet (use
 * backupToGitHub for the first one). On success the review feed
 * (origin..HEAD) clears; on failure it surfaces a toast and, for a scope
 * problem, a reconnect prompt. */
export async function pushVault(): Promise<void> {
  const vault = getActiveVaultPath()
  if (!vault) return
  const sync = useSyncStore.getState()
  if (!sync.repoFullName) return // not backed up yet
  if (pushInFlight || sync.status === 'pushing') return

  pushInFlight = true
  useSyncStore.getState().setPushing()
  try {
    await invoke('vault_push', { vaultPath: vault })
    await useGitStore.getState().refreshActivity()
    useSyncStore.getState().setPushed(useGitStore.getState().headSha)
  } catch (e) {
    const msg = String(e)
    if (/reconnect|denied|scope|repo\) access/i.test(msg)) {
      useSyncStore.getState().setError(msg)
      toast.error('Reconnect GitHub to back up.', {
        action: {
          label: 'Reconnect',
          onClick: () => useConnectGitHubDialog.getState().setOpen(true),
        },
      })
    } else {
      useSyncStore.getState().setPending(msg)
      toast.error(`Backup failed: ${msg}`)
    }
  } finally {
    pushInFlight = false
  }
}
