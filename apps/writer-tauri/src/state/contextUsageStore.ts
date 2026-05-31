// Per-thread context-usage snapshots for the PromptInput gauge.
//
// In-memory only (not persisted to disk): the snapshot is a derived,
// per-session view that the runner refreshes on every chat/done. A fresh
// app start therefore shows an empty gauge until the next turn completes —
// acceptable for a status indicator, and it keeps ThreadMeta's on-disk
// schema unchanged. Revisit with a small persisted summary if surviving
// reload becomes a requirement.

import { create } from 'zustand'
import type { ContextSnapshot } from '@/chat/types'

interface ContextUsageState {
  /** Latest snapshot per thread id. */
  byThread: Record<string, ContextSnapshot>
  /** Record the post-turn context state for a thread. Called by the chat
   * runner when a `claude:done` notification arrives. */
  set: (threadId: string, snapshot: ContextSnapshot) => void
  /** Drop a thread's snapshot (e.g. on thread delete). No-op when absent. */
  clear: (threadId: string) => void
}

export const useContextUsageStore = create<ContextUsageState>((set) => ({
  byThread: {},
  set: (threadId, snapshot) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: snapshot } })),
  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s
      const next = { ...s.byThread }
      delete next[threadId]
      return { byThread: next }
    }),
}))
