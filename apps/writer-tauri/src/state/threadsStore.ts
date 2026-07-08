// In-memory store + disk sync for chat threads.
//
// Why this exists:
//   The pre-4.F implementation lived inside the document's Y.Doc
//   (`ydoc.getArray('threads')` + `ydoc.getArray('thread:<id>')`). That
//   coupling meant chat threads were invisible outside the binary
//   .ydoc file and rode the same observer churn as body edits. Phase
//   4.F moves them to standalone vault files (threads/<id>.json
//   + threads/<id>.turns.jsonl) so grep / git / vim can see them
//   and so a thread's lifetime is no longer tied to whether the
//   parent doc is open in memory.
//
// This store is the single in-memory mirror of the on-disk files.
// React hooks (`useThreads`, `useThreadTurns`) subscribe to it via
// zustand selectors; the agent layer reaches in directly when it
// needs to enumerate threads for ingest.
//
// Sync policy:
//   Every mutation does its disk write inline (await) before
//   returning. Threads / turns are mutated at human typing speed —
//   a few writes per minute at most — so per-mutation file I/O
//   stays imperceptible. Critically this means a successful action
//   returns to the caller with the on-disk state already updated,
//   so a crash immediately after an `await` cannot lose the change.
//   Doc-body edits use a different policy (debounced batch flush)
//   because they fire dozens of times per second; that machinery
//   isn't needed here.
//
// Hydrate:
//   Called once on boot after the vault is selected. Scans
//   `threads/` and loads every meta + turns file into memory. The
//   data set is small (a thread is a few KB of meta + however many
//   turns the user has accumulated, typically <100 KB) so a full
//   eager load avoids the complexity of lazy hydration. Revisit if
//   this becomes measurable.

import { create } from 'zustand'
import type { ChatTurn, ThreadMeta } from '@/chat/types'
import { useContextUsageStore } from '@/state/contextUsageStore'
import {
  appendThreadTurn,
  appendThreadTurns,
  deleteThreadFiles,
  listThreadIds,
  readThreadMeta,
  readThreadTurns,
  rewriteThreadTurns,
  writeThreadMeta,
} from '@/lib/threadFiles'

interface ThreadsState {
  /** All thread metas indexed by id. */
  threads: Record<string, ThreadMeta>
  /** Per-thread turns, keyed by thread id. Always present for every
   * id in `threads` (the hydrate path initialises empty arrays for
   * threads with no turns file). */
  turns: Record<string, ChatTurn[]>
  /** True once {@link hydrate} has finished the boot scan. Hooks
   * gate on this so an empty Map during boot doesn't read as
   * "user has zero threads" and trigger a spurious blank thread
   * auto-create. */
  hydrated: boolean

  /** Boot-time disk scan. Idempotent: a second call is a no-op so
   * App.tsx + StrictMode double-mount are both safe. */
  hydrate: () => Promise<void>

  /** Persist a new thread to disk and add it to the store. Caller
   * supplies the full meta (id already minted, defaults filled in)
   * so this layer doesn't need to know about the various default
   * sources (per-thread model, effort, etc.). */
  createThread: (meta: ThreadMeta) => Promise<void>

  /** Patch a thread's metadata, persisting the merged record to
   * disk. No-op when the id is unknown. */
  updateMeta: (id: string, patch: Partial<ThreadMeta>) => Promise<void>

  /** Append one turn to a thread. Atomic at the JSONL append layer
   * (vault.ts's appendVaultFile) — the on-disk file gets the new
   * line as a single write. */
  appendTurn: (id: string, turn: ChatTurn) => Promise<void>

  /** Append several turns to a thread in one atomic write, preserving their
   * order. Needed when more than one turn must land back-to-back (the
   * AskUserQuestion turn-split appends the committed pre-question turn and the
   * answer bubble together) — separate appendTurn calls would race on the
   * read-modify-write and could drop or reorder a turn. */
  appendTurns: (id: string, turns: ChatTurn[]) => Promise<void>

  /** Replace a thread's turn list outright. Used by Regenerate
   * (drop the last assistant turn before running a fresh one).
   * Costs O(n) — fine because remove is rare compared to append. */
  rewriteTurns: (id: string, turns: ChatTurn[]) => Promise<void>

  /** Hard-delete a thread (meta + turns file). Used by parent-doc
   * cleanup. No-op when unknown. */
  removeThread: (id: string) => Promise<void>
}

let hydratePromise: Promise<void> | null = null

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threads: {},
  turns: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    // De-dupe concurrent calls during a single boot. StrictMode
    // double-mounts the effect that calls us, and we don't want to
    // pay two disk scans (or worse, race the second one against the
    // first's partial state).
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      const ids = await listThreadIds()
      const threads: Record<string, ThreadMeta> = {}
      const turns: Record<string, ChatTurn[]> = {}
      // Sequential reads — the file count is small and parallel I/O
      // here would tax the Tauri IPC layer for no real win.
      for (const id of ids) {
        const meta = await readThreadMeta(id)
        if (!meta) continue
        threads[meta.id] = meta
        turns[meta.id] = await readThreadTurns(meta.id)
        // Rehydrate the context gauge from the thread's last persisted
        // snapshot so a resumed session shows its real fill on boot instead
        // of an empty gauge until the next turn completes.
        if (meta.contextUsage) {
          useContextUsageStore.getState().set(meta.id, meta.contextUsage)
        }
      }
      set({ threads, turns, hydrated: true })
    })()
    try {
      await hydratePromise
    } finally {
      hydratePromise = null
    }
  },

  createThread: async (meta) => {
    await writeThreadMeta(meta)
    set((s) => ({
      threads: { ...s.threads, [meta.id]: meta },
      // Initialise the turns slot so consumers reading
      // `turns[id] ?? []` always see an array and not undefined.
      turns: { ...s.turns, [meta.id]: [] },
    }))
  },

  updateMeta: async (id, patch) => {
    const current = get().threads[id]
    if (!current) return
    const next: ThreadMeta = { ...current, ...patch }
    await writeThreadMeta(next)
    set((s) => ({ threads: { ...s.threads, [id]: next } }))
  },

  appendTurn: async (id, turn) => {
    if (!get().threads[id]) return
    // Optimistic: reflect in memory first so the turn renders immediately,
    // then persist. Persisting first gated the render on disk I/O — and the
    // streaming view is cleared synchronously at commit — so on a slow vault a
    // just-committed turn briefly vanished (read as a blank turn). Keep the
    // in-memory turn even if the disk write fails; just surface the failure.
    set((s) => ({
      turns: { ...s.turns, [id]: [...(s.turns[id] ?? []), turn] },
    }))
    try {
      await appendThreadTurn(id, turn)
    } catch (e) {
      console.error('[threadsStore] appendTurn persist failed', e)
    }
  },

  appendTurns: async (id, turns) => {
    if (!get().threads[id] || turns.length === 0) return
    set((s) => ({
      turns: { ...s.turns, [id]: [...(s.turns[id] ?? []), ...turns] },
    }))
    try {
      await appendThreadTurns(id, turns)
    } catch (e) {
      console.error('[threadsStore] appendTurns persist failed', e)
    }
  },

  rewriteTurns: async (id, nextTurns) => {
    if (!get().threads[id]) return
    await rewriteThreadTurns(id, nextTurns)
    set((s) => ({ turns: { ...s.turns, [id]: nextTurns } }))
  },

  removeThread: async (id) => {
    await deleteThreadFiles(id)
    set((s) => {
      const threads = { ...s.threads }
      const turns = { ...s.turns }
      delete threads[id]
      delete turns[id]
      return { threads, turns }
    })
  },
}))

// Dev-only console handle:
//   await __threads.hydrate()
//   __threads.list()         — all metas
//   __threads.turns('id')    — turns for one thread
if (import.meta.env.DEV) {
  ;(window as unknown as { __threads: Record<string, unknown> }).__threads = {
    hydrate: () => useThreadsStore.getState().hydrate(),
    list: () => Object.values(useThreadsStore.getState().threads),
    turns: (id: string) => useThreadsStore.getState().turns[id] ?? [],
    state: () => useThreadsStore.getState(),
  }
}
