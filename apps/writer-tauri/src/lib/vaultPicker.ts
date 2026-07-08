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
import { exists, mkdir, readDir } from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'
import { VAULT_SUBDIRS } from '@/lib/vault'
import { notify } from '@/lib/notify'

/** Compute the default vault location (`~/Writer`). Uses the home dir
 * (not Documents) on purpose: `~/Documents` is iCloud-synced when the
 * user has "Desktop & Documents Folders" on, and iCloud's dataless-file
 * eviction breaks trash/rename and adds sync lag for an app doing
 * frequent file I/O. A plain home folder stays local. Returns null when
 * the platform doesn't expose homeDir so callers fall back gracefully. */
async function defaultVaultPath(): Promise<string | null> {
  try {
    const home = await homeDir()
    return await join(home, 'Writer')
  } catch {
    return null
  }
}

/** Ensure the default vault folder exists on disk so the OS picker
 * can navigate INTO it (instead of dropping the user at ~/Documents
 * and asking them to type "Writer" themselves). Side effect only —
 * does not register anything in settingsStore. Returns the path on
 * success, null when documentDir is unavailable. */
async function ensureDefaultVaultFolder(): Promise<string | null> {
  const path = await defaultVaultPath()
  if (!path) return null
  if (!(await exists(path))) {
    await mkdir(path, { recursive: true })
  }
  return path
}

/** Decide whether a user-picked folder is acceptable as a vault.
 *
 * Policy: "one folder = one Writer vault". Acceptable when:
 *   - empty (a fresh vault), OR
 *   - it's already a Writer vault — identified by a marker the app
 *     always writes: a standard subdir (`wiki/`, `_system/`, …) or
 *     `CLAUDE.md`.
 *
 * The old rule ("only our subdirs, no foreign files") no longer fits:
 * a flat vault holds arbitrary user folders + files (inbox/, articles/,
 * notes at the root, …), so we detect "is this OUR vault" by marker
 * presence instead of rejecting everything unrecognised. A random
 * folder with the user's own files and no marker is still rejected so
 * we don't scatter our structure into it.
 *
 * Hidden entries (starting with `.`) are ignored. */
async function isAcceptableVaultFolder(path: string): Promise<boolean> {
  const entries = await readDir(path)
  const visible = entries.filter((e) => !e.name.startsWith('.'))
  if (visible.length === 0) return true

  const names = new Set(visible.map((e) => e.name))
  const markers = [...VAULT_SUBDIRS, 'CLAUDE.md']
  return markers.some((m) => names.has(m))
}

/** Open the OS folder picker and persist the selection. Returns the
 * chosen absolute path on success, or null when the user cancels or
 * picks an unacceptable folder.
 *
 * Acceptable folder = empty, or already a Writer vault. See
 * {@link isAcceptableVaultFolder}.
 *
 * No side effects: under the window-per-project model the caller decides
 * what to do with the path (scaffold it, record it as recent, open it in a
 * window). Tauri auto-adds the picked path to the fs scope for this session
 * (see plugin-dialog docs); subsequent app launches re-add via the static
 * fs:scope in capabilities/default.json. */
export async function pickVault(): Promise<string | null> {
  // Pre-create the default vault folder so the picker opens INSIDE it
  // (the user can just click "Choose" without typing a folder name).
  // Picking a different location still works — the user navigates
  // away from the default in the dialog as usual.
  const defaultPath = (await ensureDefaultVaultFolder()) ?? undefined
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
  const acceptable = await isAcceptableVaultFolder(result)
  if (!acceptable) {
    notify.vaultFolderNotAcceptable(result)
    return null
  }
  return result
}

// Dev-only console handle so we can smoke-test the picker without
// wiring it to a UI surface yet. Open DevTools, run `__pickVault()`.
if (import.meta.env.DEV) {
  ;(window as unknown as { __pickVault: () => Promise<string | null> }).__pickVault = pickVault
}
