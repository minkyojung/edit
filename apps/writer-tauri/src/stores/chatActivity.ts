// Counts in-flight chat / review streams across the app. The close-confirm
// dialog reads this to decide whether to interrupt a quit attempt.
//
// Counter, not a boolean: multiple chats can run concurrently across threads
// (chat sidecar is multiplexed), so we need to know when the last one ends.

import { create } from 'zustand'

interface ChatActivityStore {
  activeCount: number
  start: () => void
  end: () => void
}

export const useChatActivity = create<ChatActivityStore>((set) => ({
  activeCount: 0,
  start: () => set((s) => ({ activeCount: s.activeCount + 1 })),
  end: () => set((s) => ({ activeCount: Math.max(0, s.activeCount - 1) })),
}))
