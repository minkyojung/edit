// Track B — restore + receive. Mirrors vaultBackup.ts's invoke-and-toast shape
// (the backup side). restoreFromGitHub clones an existing repo into the (empty)
// active vault on a new device / fresh install; pullVault receives remote
// changes (fast-forward only). The token never leaves rust — this layer only
// knows the vault path + the chosen repo.

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useSyncStore } from '@/state/syncStore'
import { useGitStore } from '@/state/gitStore'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'

/** A repo the user can restore from (camelCase mirror of rust RepoSummary). */
export interface RepoSummary {
  fullName: string
  cloneUrl: string
}

interface SyncStateResult {
  repoFullName: string
  remoteUrl: string
  branch: string
  vaultId: string
  status: string
}

/** The signed-in user's own repos, newest first, for the restore picker.
 * Empty list when GitHub isn't connected. */
export async function listMyRepos(): Promise<RepoSummary[]> {
  return invoke<RepoSummary[]>('github_list_repos')
}

/** Restore the active vault from `repo` by cloning it (new device / fresh
 * install). The active vault path must be an EMPTY folder — rust refuses to
 * clobber existing notes. On success the repo is bound in syncStore and the
 * review feed refreshes. Returns true on success. */
export async function restoreFromGitHub(repo: RepoSummary): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) {
    toast.error('Pick an empty folder for the restored vault first.')
    return false
  }
  const id = toast.loading(`Restoring from ${repo.fullName}…`)
  try {
    const state = await invoke<SyncStateResult>('vault_restore', {
      vaultPath: vault,
      repoFullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
    })
    useSyncStore.getState().setConnected({
      repoFullName: state.repoFullName,
      remoteUrl: state.remoteUrl,
      branch: state.branch,
      vaultId: state.vaultId,
      lastPushedSha: useGitStore.getState().headSha,
    })
    void useGitStore.getState().refreshActivity()
    toast.success(`Restored from ${state.repoFullName}`, { id })
    return true
  } catch (e) {
    const msg = String(e)
    if (/reconnect|denied|scope|repo\) access/i.test(msg)) {
      toast.error('Reconnect GitHub to restore.', {
        id,
        action: {
          label: 'Reconnect',
          onClick: () => useConnectGitHubDialog.getState().setOpen(true),
        },
      })
    } else {
      toast.error(`Restore failed: ${msg}`, { id })
    }
    return false
  }
}

let pullInFlight = false

/** Receive remote changes into the bound vault (fast-forward only). Quiet by
 * design — meant for app-open / background. Returns true when it advanced (or
 * was already current), false when nothing was received OR the histories
 * diverged (the conflict slice will turn divergence into a proper "keep both"
 * flow; for now the caller decides whether to surface it). No-ops (false) when
 * no backup is bound yet. */
export async function pullVault(): Promise<boolean> {
  const vault = getActiveVaultPath()
  if (!vault) return false
  if (!useSyncStore.getState().repoFullName) return false // not backed up yet
  if (pullInFlight) return false
  pullInFlight = true
  try {
    const advanced = await invoke<boolean>('vault_pull', { vaultPath: vault })
    if (advanced) await useGitStore.getState().refreshActivity()
    return advanced
  } catch (e) {
    // Network / auth hiccup — stay quiet on a background pull; next one retries.
    console.warn('[vault-pull] failed', e)
    return false
  } finally {
    pullInFlight = false
  }
}
