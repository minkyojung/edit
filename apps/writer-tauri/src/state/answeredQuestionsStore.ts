// Hand-off for the AskUserQuestion answer bubble, keyed by threadId.
//
// When the user answers a plan-mode clarifying question, QuestionPanel sends
// the decision to the sidecar AND records a human-readable Q/A summary here.
// The chat runner consumes it (`take`) at the moment the answer returns from
// the SDK, splitting the assistant turn and inserting a display-only user
// "answer bubble" so the transcript shows what was chosen.
//
// Why a separate store (not pendingPermissions): the pending gate is cleared
// the instant the user answers, but the runner needs the summary slightly
// later — when the tool_result streams back. This carries it across that gap.
// One question-answer cycle per thread is in flight at a time, so threadId is
// a sufficient key. In-memory only; `take` reads-and-clears.

import { create } from 'zustand'

interface AnsweredQuestionsState {
  byThread: Record<string, string>
  /** Stash the Q/A summary text for a thread (called on answer send). */
  record: (threadId: string, text: string) => void
  /** Read-and-clear the summary for a thread (called by the runner when the
   * answer returns). Returns undefined if nothing was recorded. */
  take: (threadId: string) => string | undefined
}

export const useAnsweredQuestions = create<AnsweredQuestionsState>((set, get) => ({
  byThread: {},
  record: (threadId, text) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: text } })),
  take: (threadId) => {
    const text = get().byThread[threadId]
    if (text === undefined) return undefined
    set((s) => {
      const next = { ...s.byThread }
      delete next[threadId]
      return { byThread: next }
    })
    return text
  },
}))
