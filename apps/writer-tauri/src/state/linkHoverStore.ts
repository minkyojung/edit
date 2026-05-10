// State for the link hover bar (Open / Edit / Remove). The bar lives
// in React, but we share its visibility/target through a zustand store
// so a single PM plugin can drive it without prop drilling.
//
// `from`/`to` are the source of truth for the link's location in the
// document — anchor element is kept around for positioning math
// (getBoundingClientRect at render time stays fresh under scroll).

import { create } from 'zustand'

export interface LinkHoverActive {
  href: string
  from: number
  to: number
  anchor: HTMLAnchorElement
}

interface LinkHoverState {
  active: LinkHoverActive | null
  setActive: (a: LinkHoverActive | null) => void
}

export const useLinkHoverStore = create<LinkHoverState>((set) => ({
  active: null,
  setActive: (a) => set({ active: a }),
}))

if (import.meta.env.DEV) {
  ;(window as unknown as { linkHoverStore: typeof useLinkHoverStore }).linkHoverStore =
    useLinkHoverStore
}
