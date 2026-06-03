// Per-thread ACTUAL fast-mode state, as reported by the SDK on each turn.
//
// This is the "truth" half of fast mode: the user's *request* lives on
// ThreadMeta.fastMode, but the SDK reports what actually happened via the
// result's `fast_mode_state` — which can be `cooldown` (a rate limit forced it
// off) even when we asked for `on`. The FastToggle reads this to show the real
// state, mirroring how the context gauge reads getContextUsage().
//
// In-memory only (like contextUsageStore): a derived per-session view the
// runner refreshes on every claude:done. A fresh app start shows no state until
// the next turn completes — fine for a status indicator.

import { create } from 'zustand'
import type { FastModeState } from '@/chat/types'

interface FastModeStoreState {
  /** Latest reported fast-mode state per thread id. */
  byThread: Record<string, FastModeState>
  /** Record the turn's reported fast-mode state. Called by the chat runner on
   * claude:done. */
  set: (threadId: string, state: FastModeState) => void
  /** Drop a thread's state (e.g. on thread delete). No-op when absent. */
  clear: (threadId: string) => void
}

export const useFastModeStore = create<FastModeStoreState>((set) => ({
  byThread: {},
  set: (threadId, state) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: state } })),
  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s
      const next = { ...s.byThread }
      delete next[threadId]
      return { byThread: next }
    }),
}))
