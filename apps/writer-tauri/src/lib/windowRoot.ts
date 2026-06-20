// The root folder this window is bound to (window-per-project model).
//
// Each project window is spawned with `?root=<absolute path>` in its URL
// (see the launcher's window-open path, added in a later phase). We read
// that value ONCE at module load — it never changes for a window's
// lifetime — and hold it only in memory.
//
// Why not localStorage: in Tauri all webviews of the same app SHARE one
// localStorage, so two project windows reading the active folder from a
// shared store would clobber each other. The URL param is per-window, so
// each window keeps its own root in isolation.
//
// A window with no `root` param (the launcher window, and the whole app
// during the pre-multi-window transition) returns null — callers fall
// back to the legacy single-vault settingsStore path, leaving the
// existing flow unchanged.

function readWindowRoot(): string | null {
  try {
    // The query string lives before the HashRouter `#`, so reading
    // `window.location.search` doesn't collide with the route hash.
    const root = new URLSearchParams(window.location.search).get('root')
    return root && root.trim() !== '' ? root : null
  } catch {
    return null
  }
}

/** The folder this window is bound to, or `null` for the launcher window
 * (and during the pre-multi-window transition). Read once at load. */
export const WINDOW_ROOT: string | null = readWindowRoot()

/** Deterministic 32-bit hash of a path → base36. Used to derive both the
 * project window label and per-project storage-key suffixes from the same
 * root, so a window's label and its persisted state always agree. */
export function hashPath(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Namespace a localStorage / persist key to THIS window's project.
 *
 * localStorage is shared across all windows of the app, so a key that
 * holds per-project state (the last-viewed doc, the active chat thread,
 * the doc catalog cache, …) would leak between windows if left bare. We
 * suffix it with the window's root hash so each project window reads and
 * writes its own slot. The launcher window (no WINDOW_ROOT) keeps the bare
 * key — it has no project state of its own. */
export function projectStorageKey(base: string): string {
  return WINDOW_ROOT ? `${base}::${hashPath(WINDOW_ROOT)}` : base
}
