// Vault backup/sync state (Track B). Persisted to localStorage so the UI
// can show "backed up to <repo>" across restarts. The repo binding itself
// is the durable bit; status/lastError are runtime and normalized on
// persist. Mirrors settingsStore's persist shape.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SyncStatus = 'idle' | 'backing-up' | 'connected' | 'error'

interface SyncStore {
  /** `owner/name` of the bound backup repo, or null before first backup. */
  repoFullName: string | null
  /** Remote clone URL (token-free). */
  remoteUrl: string | null
  branch: string | null
  /** Stable vault identity (from `.manila/manifest.json`). */
  vaultId: string | null
  status: SyncStatus
  lastError: string | null

  setBackingUp: () => void
  setConnected: (s: {
    repoFullName: string
    remoteUrl: string
    branch: string
    vaultId: string
  }) => void
  setError: (message: string) => void
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set) => ({
      repoFullName: null,
      remoteUrl: null,
      branch: null,
      vaultId: null,
      status: 'idle',
      lastError: null,
      setBackingUp: () => set({ status: 'backing-up', lastError: null }),
      setConnected: ({ repoFullName, remoteUrl, branch, vaultId }) =>
        set({
          repoFullName,
          remoteUrl,
          branch,
          vaultId,
          status: 'connected',
          lastError: null,
        }),
      setError: (message) => set({ status: 'error', lastError: message }),
    }),
    {
      name: 'writer-tauri:sync',
      version: 1,
      partialize: (s) => ({
        repoFullName: s.repoFullName,
        remoteUrl: s.remoteUrl,
        branch: s.branch,
        vaultId: s.vaultId,
        // Runtime states ('backing-up'/'error') shouldn't survive a
        // reload — normalize to connected when a repo is bound, else idle.
        status: s.repoFullName ? ('connected' as SyncStatus) : ('idle' as SyncStatus),
      }),
    },
  ),
)
