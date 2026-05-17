// Vault folder picker — the user-facing entry point for selecting
// where the app's wiki / daily / system pages live on disk.
//
// Wraps Tauri's plugin-dialog so the rest of the app doesn't reach
// into the plugin surface directly, and saves the result into
// settingsStore on success.
//
// First-launch default hint is ~/Documents/Writer (cross-platform via
// Tauri's documentDir()). The user can pick anywhere they have write
// access to within the fs:scope capability ($HOME / $DOCUMENT / etc).

import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { documentDir, join } from '@tauri-apps/api/path'
import { useSettingsStore } from '@/state/settingsStore'

/** Suggest the default vault location on first launch.
 * Falls back to undefined (Tauri uses OS default) if the platform
 * doesn't expose documentDir. */
async function defaultVaultHint(): Promise<string | undefined> {
  try {
    const docs = await documentDir()
    return await join(docs, 'Writer')
  } catch {
    return undefined
  }
}

/** Open the OS folder picker and persist the selection. Returns the
 * chosen absolute path on success, or null when the user cancels.
 *
 * Side effect on success: settingsStore.setActiveVaultPath(path).
 * Tauri auto-adds the picked path to the fs scope for this session
 * (see plugin-dialog docs); subsequent app launches re-add via the
 * static fs:scope in capabilities/default.json. */
export async function pickVault(): Promise<string | null> {
  const defaultPath = await defaultVaultHint()
  const result = await openDialog({
    title: 'Select Vault Folder',
    directory: true,
    multiple: false,
    canCreateDirectories: true,
    defaultPath,
  })
  if (result === null || Array.isArray(result)) {
    // Cancel → null. Array would mean multiple:true which we don't
    // set; treat defensively as cancel.
    return null
  }
  useSettingsStore.getState().setActiveVaultPath(result)
  return result
}

// Dev-only console handle so we can smoke-test the picker without
// wiring it to a UI surface yet. Open DevTools, run `__pickVault()`.
if (import.meta.env.DEV) {
  ;(window as unknown as { __pickVault: () => Promise<string | null> }).__pickVault = pickVault
}
