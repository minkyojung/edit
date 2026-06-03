import { createContext, useContext, useEffect, useState } from 'react'

export type FontOption = 'geist' | 'nunito' | 'pretendard'

const FONTS: FontOption[] = ['geist', 'nunito', 'pretendard']

type FontProviderProps = {
  children: React.ReactNode
  defaultFont?: FontOption
  storageKey?: string
}

type FontProviderState = {
  font: FontOption
  setFont: (font: FontOption) => void
}

const initialState: FontProviderState = {
  font: 'pretendard',
  setFont: () => null,
}

const FontProviderContext = createContext<FontProviderState>(initialState)

function readStoredFont(storageKey: string, fallback: FontOption): FontOption {
  const raw = localStorage.getItem(storageKey)
  return FONTS.includes(raw as FontOption) ? (raw as FontOption) : fallback
}

export function FontProvider({
  children,
  defaultFont = 'pretendard',
  storageKey = 'writer-tauri:font',
  ...props
}: FontProviderProps): React.ReactElement {
  const [font, setFontState] = useState<FontOption>(() =>
    readStoredFont(storageKey, defaultFont)
  )

  useEffect(() => {
    const root = window.document.documentElement
    FONTS.forEach((f) => root.classList.remove(`font-${f}`))
    root.classList.add(`font-${font}`)
  }, [font])

  const value = {
    font,
    setFont: (next: FontOption) => {
      localStorage.setItem(storageKey, next)
      setFontState(next)
    },
  }

  return (
    <FontProviderContext.Provider {...props} value={value}>
      {children}
    </FontProviderContext.Provider>
  )
}

export const useFont = (): FontProviderState => {
  const context = useContext(FontProviderContext)
  if (context === undefined) {
    throw new Error('useFont must be used within a FontProvider')
  }
  return context
}
