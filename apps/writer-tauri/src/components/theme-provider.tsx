import { createContext, useContext, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type Palette = 'dark' | 'light' | 'graphite'

const PALETTES: Palette[] = ['dark', 'light', 'graphite']
const DARK_PALETTES: ReadonlySet<Palette> = new Set<Palette>(['dark', 'graphite'])

type ThemeProviderProps = {
  children: React.ReactNode
  defaultPalette?: Palette
  storageKey?: string
}

type ThemeProviderState = {
  palette: Palette
  setPalette: (palette: Palette) => void
}

const initialState: ThemeProviderState = {
  palette: 'dark',
  setPalette: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

function readStoredPalette(storageKey: string, fallback: Palette): Palette {
  const raw = localStorage.getItem(storageKey)
  return PALETTES.includes(raw as Palette) ? (raw as Palette) : fallback
}

export function ThemeProvider({
  children,
  defaultPalette = 'dark',
  storageKey = 'zurich-palette',
  ...props
}: ThemeProviderProps): React.ReactElement {
  const [palette, setPaletteState] = useState<Palette>(() =>
    readStoredPalette(storageKey, defaultPalette)
  )

  useEffect(() => {
    const root = window.document.documentElement
    PALETTES.forEach((p) => root.classList.remove(`palette-${p}`))
    root.classList.remove('light', 'dark')

    const isDark = DARK_PALETTES.has(palette)
    root.classList.add(`palette-${palette}`)
    root.classList.add(isDark ? 'dark' : 'light')

    // Sync the NATIVE window appearance (NSAppearance) to the palette so the
    // vibrancy material (windowEffects: sidebar) frosts in the matching
    // light/dark mode. Without this the CSS theme and the native material
    // diverge — a light palette over a dark-appearance material is illegible.
    // Fire-and-forget + guarded: no-ops outside the Tauri runtime (e.g. plain
    // browser dev).
    void getCurrentWindow()
      .setTheme(isDark ? 'dark' : 'light')
      .catch(() => {})
  }, [palette])

  const value = {
    palette,
    setPalette: (next: Palette) => {
      localStorage.setItem(storageKey, next)
      setPaletteState(next)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = (): ThemeProviderState => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
