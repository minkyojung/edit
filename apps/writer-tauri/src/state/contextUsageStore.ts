// Per-thread context-usage snapshots for the PromptInput gauge.
//
// This store is the in-memory source the gauge reads. The runner refreshes it
// on every chat/done and also persists the latest snapshot to
// ThreadMeta.contextUsage; threadsStore.hydrate seeds this store back from
// those persisted snapshots on boot, so a resumed session shows its real fill
// instead of an empty gauge.

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
