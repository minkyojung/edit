import { createContext, useContext, useEffect, useState } from 'react'

export type Palette = 'charcoal' | 'graphite' | 'olive' | 'paper' | 'mist'

const PALETTES: Palette[] = ['charcoal', 'graphite', 'olive', 'paper', 'mist']
const DARK_PALETTES: ReadonlySet<Palette> = new Set<Palette>(['charcoal', 'graphite', 'olive'])

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
  palette: 'charcoal',
  setPalette: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

function readStoredPalette(storageKey: string, fallback: Palette): Palette {
  const raw = localStorage.getItem(storageKey)
  return PALETTES.includes(raw as Palette) ? (raw as Palette) : fallback
}

export function ThemeProvider({
  children,
  defaultPalette = 'charcoal',
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

    root.classList.add(`palette-${palette}`)
    root.classList.add(DARK_PALETTES.has(palette) ? 'dark' : 'light')
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
