// "Read / unread" state for chat sessions, KakaoTalk-style.
//
// A session is UNREAD when new turns arrived since the user last looked
// at it. We track that with the turn COUNT at the moment it was last
// viewed — `thread.updatedAt` doesn't move on new messages (only on meta
// edits like rename), but `turns[id]` always grows, so the count is the
// reliable activity signal.
//
// This is a per-view, per-device record (not thread content), so it lives
// in localStorage, namespaced per project window like the active thread.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { projectStorageKey } from '@/lib/windowRoot'

interface SeenThreadsState {
  /** threadId → turn count when the user last viewed it. */
  lastSeenCount: Record<string, number>
  /** Record that the user is looking at `threadId`, which currently has
   * `count` turns. Idempotent — repeats with the same count are no-ops. */
  markSeen: (threadId: string, count: number) => void
}

export const useSeenThreads = create<SeenThreadsState>()(
  persist(
    (set) => ({
      lastSeenCount: {},
      markSeen: (threadId, count) =>
        set((s) => {
          if (s.lastSeenCount[threadId] === count) return s
          return { lastSeenCount: { ...s.lastSeenCount, [threadId]: count } }
        }),
    }),
    { name: projectStorageKey('writer-tauri:seen-threads') },
  ),
)
