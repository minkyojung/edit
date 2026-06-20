// Open a project in its own window (window-per-project model).
//
// Each project window carries its root in the URL (`?root=<path>`), which
// windowRoot.ts reads at startup and getActiveVaultPath() returns — so the
// window stays bound to its own folder, isolated from every other window's
// stores and from the shared, cross-window localStorage.
//
// The window label is derived deterministically from the path, so opening
// an already-open project focuses the existing window instead of spawning
// a duplicate (the VS Code behaviour).

import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

/** Deterministic 32-bit hash → base36. Window labels only allow
 * `[a-zA-Z0-9-/:_]`, so a raw path (spaces, unicode folder names) can't be
 * a label — we hash it. Collisions across a user's handful of projects are
 * negligible, and a collision only means two projects would share a window,
 * not data corruption (each window still reads its own `?root`). */
function hashPath(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** The window label for a project at `path`. Stable for a given path. */
export function projectWindowLabel(path: string): string {
  return `project-${hashPath(path)}`
}

/** Open `path` in a project window. Focuses the existing window if this
 * project is already open; otherwise spawns a new one and waits for it to
 * be created (so creation errors surface instead of failing silently). */
export async function openProjectWindow(
  path: string,
  title: string,
): Promise<void> {
  const label = projectWindowLabel(path)

  const existing = await WebviewWindow.getByLabel(label)
  if (existing) {
    await existing.setFocus()
    return
  }

  // Match the config-defined main window's chrome (overlay title bar,
  // transparent canvas for the macOS vibrancy the React app re-applies at
  // runtime via useVibrancy).
  const win = new WebviewWindow(label, {
    url: `index.html?root=${encodeURIComponent(path)}`,
    title,
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    transparent: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    dragDropEnabled: false,
  })

  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve())
    void win.once('tauri://error', (e) =>
      reject(new Error(`Failed to open project window: ${String(e.payload)}`)),
    )
  })
}
