import { useEffect } from 'react'
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'
import { useSettingsStore } from '@/state/settingsStore'
import { useWindowModeStore } from '@/state/windowModeStore'

export function useVibrancy() {
  const enabled = useSettingsStore((s) => s.sidebarVibrancyEnabled)
  const mode = useWindowModeStore((s) => s.mode)
  useEffect(() => {
    // The compact panel IS a frosted surface by definition, so it forces
    // vibrancy on regardless of the user's global setting (which only governs
    // the full window's sidebar). data-vibrancy drives the CSS: 'on' keeps the
    // body transparent so the native material shows; 'off' paints it opaque.
    // data-window-mode lets index.css apply the compact panel's theme tint.
    const effectiveOn = enabled || mode === 'compact'
    document.documentElement.dataset.vibrancy = effectiveOn ? 'on' : 'off'
    document.documentElement.dataset.windowMode = mode
    const win = getCurrentWindow()
    const apply = effectiveOn
      ? win.setEffects({ effects: [Effect.Sidebar], state: EffectState.Active })
      : win.clearEffects()
    void apply.catch((e) => console.warn('[vibrancy] effect toggle failed', e))
  }, [enabled, mode])
}
