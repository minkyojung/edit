// State for the slash command menu. Same shape as linkHoverStore: a
// PM plugin pushes the active range/query/coords here, the React-side
// SlashMenu subscribes to render. Decoupling lets the trigger plugin
// stay UI-free (and lets us verify it via the DevTools subscription
// before any UI exists).

import { create } from 'zustand'

export interface SlashActive {
  /** Document offset of the leading `/` of the trigger. */
  from: number
  /** Document offset just past the last query character. */
  to: number
  /** Text after the `/`, used by the menu for fuzzy filtering. */
  query: string
  /** Viewport coords of the trigger's `/`, for popover positioning. */
  coords: { left: number; top: number; bottom: number }
}

interface SlashState {
  active: SlashActive | null
  setActive: (a: SlashActive | null) => void
}

export const useSlashStore = create<SlashState>((set) => ({
  active: null,
  setActive: (a) => set({ active: a }),
}))

if (import.meta.env.DEV) {
  ;(window as unknown as { slashStore: typeof useSlashStore }).slashStore =
    useSlashStore
}
