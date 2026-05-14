// Tracks in-flight chat runs across the app, keyed by runId, with the
// owning threadId attached. Lives outside React so a run survives
// component re-renders and remains addressable from anywhere — most
// importantly from `archiveThread`, which needs to abort a thread's
// runs even when the relevant ChatPanel may have unmounted.
//
// chatActivity (sibling store) still tracks a global in-flight count
// for the quit-confirm modal; this store layers ownership on top.

import { create } from 'zustand'

interface ChatRun {
  runId: string
  threadId: string
  /** Slug of the doc this run is bound to (captured at runChat start).
   * Set when `slug` is provided to start(); legacy callers that don't
   * pass it leave it undefined, in which case abortBySlug never matches
   * the run. */
  slug?: string
  controller: AbortController
  startedAt: number
}

interface ChatRunsStore {
  runs: Map<string, ChatRun>
  start: (
    threadId: string,
    runId: string,
    controller: AbortController,
    slug?: string,
  ) => void
  end: (runId: string) => void
  abortByThread: (threadId: string) => void
  /** Abort every run bound to `slug`. Called from docsStore when the
   * owning doc is closed/archived — the captured ydoc is about to be
   * destroyed, so writes from late proposals would land on a dead
   * fragment. */
  abortBySlug: (slug: string) => void
  abortAll: () => void
}

export const useChatRuns = create<ChatRunsStore>((set, get) => ({
  runs: new Map(),
  start: (threadId, runId, controller, slug) => {
    set((s) => {
      const next = new Map(s.runs)
      next.set(runId, { runId, threadId, slug, controller, startedAt: Date.now() })
      return { runs: next }
    })
  },
  end: (runId) => {
    set((s) => {
      if (!s.runs.has(runId)) return s
      const next = new Map(s.runs)
      next.delete(runId)
      return { runs: next }
    })
  },
  abortByThread: (threadId) => {
    const { runs } = get()
    for (const run of runs.values()) {
      if (run.threadId === threadId) {
        try {
          run.controller.abort()
        } catch {
          // best-effort — listener teardown will follow on the CANCELLED event
        }
      }
    }
    // Entries are removed via `end()` from the runChat finally-block when the
    // CANCELLED notification arrives. Keeping the entry until then lets late
    // events still find their owner thread.
  },
  abortBySlug: (slug) => {
    const { runs } = get()
    for (const run of runs.values()) {
      if (run.slug === slug) {
        try {
          run.controller.abort()
        } catch {
          // best-effort — listener teardown on CANCELLED
        }
      }
    }
  },
  abortAll: () => {
    const { runs } = get()
    for (const run of runs.values()) {
      try {
        run.controller.abort()
      } catch {
        // best-effort
      }
    }
  },
}))
