// Drives the macOS sidebar vibrancy on/off from the persisted setting.
//
// Two things must move together (otherwise a transparent window with the
// effect cleared just shows raw desktop): the NATIVE window effect and the
// CSS canvas opacity. This hook owns both — it calls Tauri's
// setEffects/clearEffects AND flips `html[data-vibrancy]`, which index.css
// reads to paint the canvas + sidebar opaque when off.
//
// macOS-only in practice; the native call is wrapped so it harmlessly no-ops
// (and logs) on platforms without the effect.
import { useEffect } from 'react'
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'
import { useSettingsStore } from '@/state/settingsStore'

export function useVibrancy() {
  const enabled = useSettingsStore((s) => s.sidebarVibrancyEnabled)
  useEffect(() => {
    document.documentElement.dataset.vibrancy = enabled ? 'on' : 'off'
    const win = getCurrentWindow()
    const apply = enabled
      ? win.setEffects({ effects: [Effect.Sidebar], state: EffectState.Active })
      : win.clearEffects()
    void apply.catch((e) => console.warn('[vibrancy] effect toggle failed', e))
  }, [enabled])
}
