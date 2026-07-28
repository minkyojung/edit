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
import type { ChatTurn, FileAttachment } from '@/chat/types'
import type { PromptStatus } from '@/chat/PromptInput'

interface ThreadTurnState {
  status: PromptStatus
  /** The in-flight assistant turn (local, pre-Yjs). Null between turns. */
  streamingTurn: ChatTurn | null
  /** User turns typed while an answer was still streaming, oldest first.
   *
   * This third state had to exist. There were only settled turns (Yjs) and the
   * streaming answer, so a queued turn went straight into the settled list —
   * where it renders ABOVE the answer still being written, because ChatPanel
   * composes `[...turns, streamingTurn]`. It read as the message vanishing:
   * the user watches the bottom, and it had been inserted into the middle.
   *
   * Deliberately not in Yjs. These turns have not run, so they are not history
   * yet; committing them would sync a message that might still be cancelled,
   * and would place it wrongly in the transcript. They move into `turns` at the
   * moment they are dispatched. */
  queued: QueuedTurn[]
}

/** A parked turn plus the two run arguments that do NOT live on ChatTurn.
 * `turn.attachments` is the visible context chips; these are the files and
 * @-mentioned paths the run itself needs, and they have to travel with the turn
 * or a queued message would silently lose its attachments on dispatch. */
export interface QueuedTurn {
  turn: ChatTurn
  attachments?: FileAttachment[]
  mentionPaths?: string[]
}

const IDLE: ThreadTurnState = { status: 'idle', streamingTurn: null, queued: [] }

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
  /** Park a user turn behind the answer currently streaming. */
  enqueueTurn: (threadId: string, item: QueuedTurn) => void
  /** Take the oldest queued turn, or null. Removal and dispatch stay with one
   * caller, so a turn is never both parked and in flight: the drain effect can
   * fire twice for one idle transition, and the second call finds the queue
   * already shortened and returns null. zustand's `set` is synchronous, so the
   * two calls cannot interleave — an earlier version re-read the head inside
   * `set` to guard against that, which no test could distinguish from this. */
  dequeueTurn: (threadId: string) => QueuedTurn | null
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
  enqueueTurn: (threadId, item) => {
    set((s) => {
      const cur = s.byThread.get(threadId) ?? IDLE
      const next = new Map(s.byThread)
      next.set(threadId, { ...cur, queued: [...cur.queued, item] })
      return { byThread: next }
    })
  },
  dequeueTurn: (threadId) => {
    const cur = get().byThread.get(threadId)
    if (!cur?.queued.length) return null
    const [head, ...rest] = cur.queued
    set((s) => {
      const c = s.byThread.get(threadId)
      if (!c) return s
      const next = new Map(s.byThread)
      next.set(threadId, { ...c, queued: rest })
      return { byThread: next }
    })
    return head
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
