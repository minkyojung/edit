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
  /** True once the user has finished (or skipped) the first-run
   * BootstrapDialog. Persisted to localStorage so the dialog only
   * appears once per browser profile. */
  bootstrapCompleted: boolean
  /** Timestamp (ms since epoch) when the URL → Profile bootstrap
   * created the wiki:profile page. The on-page banner uses this
   * to know "this profile was just AI-generated, show the review
   * banner." Null when the user skipped bootstrap or hasn't done
   * one yet. */
  profileBootstrappedAt: number | null
  /** True once the user dismissed the profile review banner.
   * Re-running bootstrap clears this so the banner reappears on
   * the freshly-regenerated page. */
  profileBannerDismissed: boolean
  /** Transient — true while the BootstrapDialog should be visible.
   * Intentionally NOT persisted: dialog visibility is a runtime
   * concern, not a setting. Set true by BootGate on first launch
   * (when bootstrapCompleted is false) or by the ProfileBanner
   * "Regenerate" action; cleared by the dialog's own onClose. */
  bootstrapDialogOpen: boolean

  /** Replace the active vault path. v1 normalises to single-entry
   * array (legacy entries get overwritten, not appended). */
  setActiveVaultPath: (path: string) => void
  /** Clear the active vault — used when the user explicitly resets
   * or when boot detects the saved path no longer exists. */
  clearVault: () => void
  /** Flip bootstrapCompleted to true. Called by BootstrapDialog on
   * Finish / Skip. Idempotent. */
  markBootstrapCompleted: () => void
  /** Stamp the profile-bootstrap timestamp + clear the dismissed
   * flag. Called after a successful URL → Profile run so the
   * banner reappears on the freshly-saved page. */
  markProfileBootstrapped: () => void
  /** User clicked the banner's dismiss control. Persists so the
   * banner stays gone across reloads until the next bootstrap. */
  dismissProfileBanner: () => void
  /** Show the BootstrapDialog. Used by ProfileBanner's regenerate
   * action and by the first-launch auto-trigger in BootGate. */
  openBootstrapDialog: () => void
  /** Hide the BootstrapDialog. Called by the dialog itself on
   * Skip / Finish / Esc / outside-click. */
  closeBootstrapDialog: () => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      vaultPaths: [],
      activeVaultIndex: 0,
      bootstrapCompleted: false,
      profileBootstrappedAt: null,
      profileBannerDismissed: false,
      bootstrapDialogOpen: false,
      setActiveVaultPath: (path) =>
        set({ vaultPaths: [path], activeVaultIndex: 0 }),
      clearVault: () => set({ vaultPaths: [], activeVaultIndex: 0 }),
      markBootstrapCompleted: () => set({ bootstrapCompleted: true }),
      markProfileBootstrapped: () =>
        set({
          profileBootstrappedAt: Date.now(),
          profileBannerDismissed: false,
        }),
      dismissProfileBanner: () => set({ profileBannerDismissed: true }),
      openBootstrapDialog: () => set({ bootstrapDialogOpen: true }),
      closeBootstrapDialog: () => set({ bootstrapDialogOpen: false }),
    }),
    {
      name: 'writer-tauri:settings',
      version: 1,
      partialize: (s) => ({
        vaultPaths: s.vaultPaths,
        activeVaultIndex: s.activeVaultIndex,
        bootstrapCompleted: s.bootstrapCompleted,
        profileBootstrappedAt: s.profileBootstrappedAt,
        profileBannerDismissed: s.profileBannerDismissed,
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
