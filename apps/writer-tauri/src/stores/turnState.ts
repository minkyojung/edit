// Per-thread turn state: the streaming buffer + the Send/regenerate status
// enum, keyed by threadId. Lives outside React (like chatRuns / chatActivity)
// so multiple chat sessions can each drive their own turn concurrently — the
// sidecar already multiplexes one query() per thread, so the only thing that
// forced single-session-at-a-time was these two values living as a single
// shared useState in useChatRunner.
//
// Reads are selector-scoped to the ACTIVE thread in ChatPanel, so a background
// session's streaming ticks never re-render or re-scroll the visible one.

import { create } from 'zustand'
import type { ChatTurn } from '@/chat/types'
import type { PromptStatus } from '@/chat/PromptInput'

interface ThreadTurnState {
  status: PromptStatus
  /** The in-flight assistant turn (local, pre-Yjs). Null between turns. */
  streamingTurn: ChatTurn | null
}

const IDLE: ThreadTurnState = { status: 'idle', streamingTurn: null }

interface TurnStateStore {
  byThread: Map<string, ThreadTurnState>
  setStatus: (threadId: string, status: PromptStatus) => void
  /** Seed / rotate / clear the streaming turn for a thread. */
  setStreamingTurn: (threadId: string, turn: ChatTurn | null) => void
  /** Merge a partial into the thread's streaming turn (the flusher's 120ms
   * tick). No-op if the thread has no streaming turn — preserves the old
   * `s && s.threadId === threadId` guard so a cleared/rotated turn is never
   * resurrected. The turn ref is only replaced when a streaming turn exists,
   * so the `status` selector stays referentially stable across ticks. */
  patchStreamingTurn: (threadId: string, patch: Partial<ChatTurn>) => void
}

export const useTurnState = create<TurnStateStore>((set, get) => ({
  byThread: new Map(),
  setStatus: (threadId, status) => {
    set((s) => {
      const cur = s.byThread.get(threadId) ?? IDLE
      if (cur.status === status) return s
      const next = new Map(s.byThread)
      next.set(threadId, { ...cur, status })
      return { byThread: next }
    })
  },
  setStreamingTurn: (threadId, turn) => {
    set((s) => {
      const cur = s.byThread.get(threadId) ?? IDLE
      const next = new Map(s.byThread)
      next.set(threadId, { ...cur, streamingTurn: turn })
      return { byThread: next }
    })
  },
  patchStreamingTurn: (threadId, patch) => {
    const cur = get().byThread.get(threadId)
    if (!cur?.streamingTurn) return
    set((s) => {
      const c = s.byThread.get(threadId)
      if (!c?.streamingTurn) return s
      const next = new Map(s.byThread)
      next.set(threadId, { ...c, streamingTurn: { ...c.streamingTurn, ...patch } })
      return { byThread: next }
    })
  },
}))
