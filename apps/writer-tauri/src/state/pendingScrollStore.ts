// Single "scroll to this mark when slug X's editor is next mounted"
// slot per slug. Set when the user clicks a chat step targeting a doc
// whose editor isn't currently mounted (different tab). Drained by
// MilkdownEditor on mount, just like pendingProposalsStore.
//
// Last write wins per slug — a user clicking two different steps in
// quick succession before switching tabs lands on the second one.

import { create } from 'zustand'

interface PendingScrollState {
  targets: Record<string, string>
  set: (slug: string, markId: string) => void
  drain: (slug: string) => string | null
  clear: (slug: string) => void
}

export const usePendingScroll = create<PendingScrollState>((set, get) => ({
  targets: {},
  set: (slug, markId) => {
    set((s) => ({ targets: { ...s.targets, [slug]: markId } }))
  },
  drain: (slug) => {
    const markId = get().targets[slug]
    if (!markId) return null
    set((s) => {
      if (!s.targets[slug]) return s
      const next = { ...s.targets }
      delete next[slug]
      return { targets: next }
    })
    return markId
  },
  clear: (slug) => {
    set((s) => {
      if (!s.targets[slug]) return s
      const next = { ...s.targets }
      delete next[slug]
      return { targets: next }
    })
  },
}))
