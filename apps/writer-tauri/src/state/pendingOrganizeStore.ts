// Bridge store for "Organize this note" → a visible chat thread.
//
// The Organize action lives in DocMenu (an editor-header dropdown), but the
// chat run dispatcher (`runner.run`) is hook-only — it exists inside ChatPanel
// and can't be called from a menu. So the menu only *records intent* here, and
// the chat components consume it across two effects (same event/queue pattern
// the slash commands use):
//
//   1. DocMenu        → setRequest({ systemPrompt, prompt, title })
//   2. RightPanel     → creates + activates a thread, opens the panel,
//                       then attachThread(threadId)
//   3. ChatPanel      → once that thread is the active one, appends the user
//                       turn + runs the agent, then clear()
//
// One request at a time; the two-phase threadId hand-off keeps RightPanel
// (thread ownership) and ChatPanel (run dispatch) from racing.

import { create } from 'zustand'

export interface OrganizeRequest {
  /** Routing brain (INBOX_PROMPT for a normal note, DAILY_INGEST_PROMPT for a daily). */
  systemPrompt: string
  /** Kickoff user message handed to the run (names the file to read). */
  prompt: string
  /** Thread title shown in the picker (e.g. "Organize <note>"). */
  title: string
  /** Filled by RightPanel once it has created + activated the thread.
   * ChatPanel runs only when this matches its active id. */
  threadId: string | null
}

interface PendingOrganizeState {
  request: OrganizeRequest | null
  /** Record a new organize intent (clears any threadId — a fresh request). */
  setRequest: (r: Omit<OrganizeRequest, 'threadId'>) => void
  /** Bind the created thread so ChatPanel knows which thread to run in. */
  attachThread: (threadId: string) => void
  /** Drop the request once the run has been dispatched. */
  clear: () => void
}

export const usePendingOrganize = create<PendingOrganizeState>((set) => ({
  request: null,
  setRequest: (r) => set({ request: { ...r, threadId: null } }),
  attachThread: (threadId) =>
    set((s) => (s.request ? { request: { ...s.request, threadId } } : s)),
  clear: () => set({ request: null }),
}))
