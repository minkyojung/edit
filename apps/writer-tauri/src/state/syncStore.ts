// Vault backup/sync state (Track B). Persisted to localStorage so the UI
// can show "backed up to <repo>" across restarts. The repo binding +
// `lastPushedSha` are the durable bits; transient statuses are normalized
// on persist. Mirrors settingsStore's persist shape.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SyncStatus =
  | 'idle'
  | 'backing-up'
  | 'connected'
  | 'pushing'
  | 'pending'
  | 'error'

interface SyncStore {
  /** `owner/name` of the bound backup repo, or null before first backup. */
  repoFullName: string | null
  /** Remote clone URL (token-free). */
  remoteUrl: string | null
  branch: string | null
  /** Stable vault identity (from `.manila/manifest.json`). */
  vaultId: string | null
  /** HEAD sha last successfully pushed. Compared against gitStore.headSha
   * to decide whether there's anything to push (no queue needed — push is
   * idempotent). */
  lastPushedSha: string | null
  status: SyncStatus
  lastError: string | null

  setBackingUp: () => void
  setConnected: (s: {
    repoFullName: string
    remoteUrl: string
    branch: string
    vaultId: string
    lastPushedSha: string | null
  }) => void
  setPushing: () => void
  setPushed: (sha: string | null) => void
  setPending: (message: string) => void
  setError: (message: string) => void
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set) => ({
      repoFullName: null,
      remoteUrl: null,
      branch: null,
      vaultId: null,
      lastPushedSha: null,
      status: 'idle',
      lastError: null,
      setBackingUp: () => set({ status: 'backing-up', lastError: null }),
      setConnected: ({ repoFullName, remoteUrl, branch, vaultId, lastPushedSha }) =>
        set({
          repoFullName,
          remoteUrl,
          branch,
          vaultId,
          lastPushedSha,
          status: 'connected',
          lastError: null,
        }),
      setPushing: () => set({ status: 'pushing', lastError: null }),
      setPushed: (sha) =>
        set({ status: 'connected', lastPushedSha: sha, lastError: null }),
      setPending: (message) => set({ status: 'pending', lastError: message }),
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
        lastPushedSha: s.lastPushedSha,
        // Runtime states ('backing-up'/'pushing'/'pending'/'error') shouldn't
        // survive a reload — normalize to connected when a repo is bound,
        // else idle. Boot catch-up re-pushes if anything is actually behind.
        status: s.repoFullName ? ('connected' as SyncStatus) : ('idle' as SyncStatus),
      }),
    },
  ),
)
