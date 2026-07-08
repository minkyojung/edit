import { useEffect, useState } from 'react'

// Re-render signal that tracks the active theme/palette WITHOUT React context.
// ThemeProvider toggles `palette-*` / `light` / `dark` classes on <html>; we
// observe that class attribute and bump a counter on every change.
//
// Why not useTheme(): the viz blocks also render inside editor NodeViews via a
// detached `createRoot`, which lives OUTSIDE the app's ThemeProvider — calling
// useTheme there throws. Observing the DOM class works in any React tree. Use
// the returned value as an effect/memo dependency to re-resolve design tokens
// (resolveTokens reads computed styles off <html>, which already reflect the
// active palette), so the visualization re-themes on a light/dark switch.
export function usePaletteSignal(): number {
  const [signal, setSignal] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setSignal((n) => n + 1))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])
  return signal
}
