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
