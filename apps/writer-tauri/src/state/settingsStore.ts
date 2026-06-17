// User-controlled app settings persisted to localStorage.
//
// Phase 4 introduces a "vault" — the user's chosen folder where the
// app's wiki / daily / system pages live as plain markdown files.
// Vault path is a setting (user picks it, can change it later); the
// app reads/writes only inside it.
//
// Schema notes
//   - vaultPaths is an array for forward compatibility — v1 only ever
//     stores length 0 (no vault picked yet) or length 1. Future multi-
//     vault support adds entries without schema migration.
//   - activeVaultIndex points into vaultPaths. In v1 it's always 0
//     once a vault is picked.
//   - Empty vaultPaths means "no vault selected yet" — the boot flow
//     prompts the user with the picker dialog before any file I/O.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SettingsState {
  /** Selected vault folders. v1 enforces length ≤ 1; future multi-
   * vault expansion appends without schema change. */
  vaultPaths: string[]
  /** Index into vaultPaths. v1 always 0 when a vault is selected. */
  activeVaultIndex: number
  /** True once the user has finished (or skipped) first-run
   * onboarding. Persisted to localStorage so onboarding only
   * appears once per browser profile. */
  bootstrapCompleted: boolean

  /** Replace the active vault path. v1 normalises to single-entry
   * array (legacy entries get overwritten, not appended). */
  setActiveVaultPath: (path: string) => void
  /** Clear the active vault — used when the user explicitly resets
   * or when boot detects the saved path no longer exists. */
  clearVault: () => void
  /** Flip bootstrapCompleted to true. Called by onboarding on
   * Finish / Skip. Idempotent. */
  markBootstrapCompleted: () => void

  /** Folder new chat-created notes land in (Obsidian's "default location for
   * new notes"). Default 'inbox'. The host FORCES this folder — the LLM's
   * chosen path is ignored — so the model can't scatter notes into wiki/ on a
   * whim. User-changeable (settings modal). */
  defaultNoteFolder: string
  /** Set the default new-note folder. Trims slashes; empty → 'inbox'. */
  setDefaultNoteFolder: (folder: string) => void

  /** macOS sidebar vibrancy (frosted glass). Default on. When off, the window
   * canvas + sidebar paint opaque instead of letting the native effect show.
   * Applied by useVibrancy(); macOS-only (no-op elsewhere). */
  sidebarVibrancyEnabled: boolean
  /** Toggle sidebar vibrancy. */
  setSidebarVibrancy: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      vaultPaths: [],
      activeVaultIndex: 0,
      bootstrapCompleted: false,
      defaultNoteFolder: 'inbox',
      sidebarVibrancyEnabled: true,
      setActiveVaultPath: (path) =>
        set({ vaultPaths: [path], activeVaultIndex: 0 }),
      clearVault: () => set({ vaultPaths: [], activeVaultIndex: 0 }),
      markBootstrapCompleted: () => set({ bootstrapCompleted: true }),
      setDefaultNoteFolder: (folder) =>
        set({ defaultNoteFolder: folder.trim().replace(/^\/+|\/+$/g, '') || 'inbox' }),
      setSidebarVibrancy: (enabled) => set({ sidebarVibrancyEnabled: enabled }),
    }),
    {
      name: 'writer-tauri:settings',
      version: 1,
      partialize: (s) => ({
        vaultPaths: s.vaultPaths,
        activeVaultIndex: s.activeVaultIndex,
        bootstrapCompleted: s.bootstrapCompleted,
        defaultNoteFolder: s.defaultNoteFolder,
        sidebarVibrancyEnabled: s.sidebarVibrancyEnabled,
      }),
    },
  ),
)

/** Read the active vault path from the store. Returns null when no
 * vault has been selected yet — callers gate file I/O on this. */
export function getActiveVaultPath(): string | null {
  const { vaultPaths, activeVaultIndex } = useSettingsStore.getState()
  return vaultPaths[activeVaultIndex] ?? null
}

/** Folder new chat-created notes land in. Default 'inbox'. Non-React read for the
 * chat materialiser (toPendingChange). */
export function getDefaultNoteFolder(): string {
  return useSettingsStore.getState().defaultNoteFolder || 'inbox'
}
