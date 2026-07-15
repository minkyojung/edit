// Re-hydrate windowModeStore.mode from the native compact flag.
//
// mode is explicit user intent (see windowModeStore), but a webview reload
// resets the store to its 'full' default while the NSWindow — and the native
// CompactFrames record — stay compact. resolveWindowMode reads that native flag
// once, BEFORE the UI paints (awaited by BootGate), so a window that was
// compact at reload renders compact from the first frame (no full→compact
// flash). Best-effort — a failure just leaves the default.
//
// Deliberately NOT tied to window size: an ordinary resize (edge drag, macOS
// left/right-half tiling) must never flip the mode.

import { invoke } from '@tauri-apps/api/core'
import { useWindowModeStore } from '@/state/windowModeStore'

export async function resolveWindowMode(): Promise<void> {
  try {
    const compact = await invoke<boolean>('is_window_compact')
    useWindowModeStore.setState({ mode: compact ? 'compact' : 'full' })
  } catch {
    // leave the default
  }
}
