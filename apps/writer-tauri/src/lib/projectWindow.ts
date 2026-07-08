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

import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Effect, EffectState } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { hashPath } from '@/lib/windowRoot'

// Re-apply the native macOS toolbar chrome (larger corner radius + pinned
// traffic-light Y) to a freshly-spawned window. The config-defined `main`
// window gets this in Rust setup(); runtime-spawned windows must ask for it
// explicitly or they fall back to the smaller titlebar radius with drifting
// traffic lights. Best-effort: a failure here only costs the radius polish.
async function applyWindowChrome(label: string): Promise<void> {
  try {
    await invoke('apply_window_chrome', { label })
  } catch (e) {
    console.warn('[projectWindow] apply_window_chrome failed', e)
  }
}

/** The window label for a project at `path`. Stable for a given path.
 *
 * Window labels only allow `[a-zA-Z0-9-/:_]`, so a raw path (spaces,
 * unicode folder names) can't be a label — we hash it. Collisions across a
 * user's handful of projects are negligible, and a collision only means two
 * projects would share a window, not data corruption (each window still
 * reads its own `?root`). */
export function projectWindowLabel(path: string): string {
  return `project-${hashPath(path)}`
}

/** Last path segment of `path`, used as a project window's display title.
 * Shared by every caller of {@link openProjectWindow} so the derivation can't
 * drift between the launcher and onboarding. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
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
    const current = getCurrentWebviewWindow()
    if (current.label === LAUNCHER_LABEL) await current.hide()
    return
  }

  // Match the config-defined main window's chrome (overlay title bar,
  // transparent canvas for the macOS vibrancy the React app re-applies at
  // runtime via useVibrancy).
  const win = new WebviewWindow(label, {
    url: `index.html?root=${encodeURIComponent(path)}`,
    title,
    // Match the launcher's fixed opening size (Rust setup forces the same on
    // the config `main` window). Centered so every project window opens
    // identically, regardless of where the last one sat.
    width: 1440,
    height: 800,
    center: true,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    transparent: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    dragDropEnabled: false,
    // Bake the native vibrancy in at creation (mirrors the config `main`
    // window's windowEffects). Without this a project window opens with NO
    // effect view — useVibrancy's runtime setEffects would be the only source,
    // which flashes on first paint and can't run until React mounts. The
    // runtime call still owns the on/off toggle + the compact material swap.
    windowEffects: { effects: [Effect.Sidebar], state: EffectState.Active },
  })

  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve())
    void win.once('tauri://error', (e) =>
      reject(new Error(`Failed to open project window: ${String(e.payload)}`)),
    )
  })
  await applyWindowChrome(label)
  // Hide the launcher. openProjectWindow() is always called from launcher
  // window context (VaultLauncher), so getCurrentWebviewWindow() is the
  // launcher itself — direct hide is more reliable than cross-window getByLabel.
  const current = getCurrentWebviewWindow()
  if (current.label === LAUNCHER_LABEL) {
    await current.hide()
  }
}

/** Label of the launcher window (the config-defined window with no
 * `?root`). Closing it runs the app-close flow, so it stays alive
 * alongside project windows. */
export const LAUNCHER_LABEL = 'main'

/** Bring the launcher (project picker) to the front so the user can open
 * another project from within a project window. Recreates it defensively
 * if it's somehow gone (normally it can't be — closing it quits the app). */
export async function focusLauncher(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(LAUNCHER_LABEL)
  if (existing) {
    await existing.setFocus()
    return
  }
  const win = new WebviewWindow(LAUNCHER_LABEL, {
    url: 'index.html',
    title: 'Octave',
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    transparent: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    dragDropEnabled: false,
    // Match the config-defined launcher's windowEffects on this JS re-creation
    // path, so a relaunched launcher keeps the same vibrancy.
    windowEffects: { effects: [Effect.Sidebar], state: EffectState.Active },
  })
  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve())
    void win.once('tauri://error', (e) =>
      reject(new Error(`Failed to open launcher: ${String(e.payload)}`)),
    )
  })
  await applyWindowChrome(LAUNCHER_LABEL)
}
