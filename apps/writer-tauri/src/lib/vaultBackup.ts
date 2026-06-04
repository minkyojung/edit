// Track B — first-backup action. Calls the rust `vault_backup_init`
// command (create private repo + push the vault), drives `syncStore`, and
// surfaces progress via toasts. The token never leaves rust; this layer
// only knows the vault path. Mirrors githubSync.ts's invoke-and-toast shape.

import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { toast } from 'sonner'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useSyncStore } from '@/state/syncStore'
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
    })
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
