// Hook surface for chat threads. Backed by `threadsStore` — a
// zustand store that mirrors the on-disk `threads/<id>.json` +
// `threads/<id>.turns.jsonl` pair (Phase 4.F file-based layout).
//
// Threads are anchored to a doc via `ThreadMeta.parentSlug`; this
// hook filters the global store down to a single slug's threads so
// the caller (ChatPanel) doesn't have to know about the file-based
// model. The pre-4.F implementation took a Y.Doc + `contentReady`
// promise — `slug` replaces both since the file-based store reads
// directly from the vault folder rather than from a per-doc Y.Doc.

import { useCallback, useMemo } from 'react'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  MAX_ACTIVE_THREADS,
  type ChatEffort,
  type ChatModel,
  type ThreadMeta,
} from '@/chat/types'
import { useChatRuns } from '@/stores/chatRuns'
import { useThreadsStore } from '@/state/threadsStore'

export interface UseThreadsResult {
  ready: boolean
  threads: ThreadMeta[]
  active: ThreadMeta[]
  archived: ThreadMeta[]
  createThread: (initialTitle?: string) => string | null
  archiveThread: (id: string) => void
  restoreThread: (id: string) => { ok: true } | { ok: false; reason: 'limit' | 'not-found' }
  renameThread: (id: string, title: string) => void
  setThreadModel: (id: string, model: ChatModel) => void
  setThreadEffort: (id: string, effort: ChatEffort) => void
  /** Marks the thread as having a confirmed SDK session. Called once per
   * thread, on the first stream event of its first run. Idempotent — repeat
   * calls short-circuit so we don't write the same value again. */
  markSessionStarted: (id: string) => void
}

export function useThreads(slug: string | null): UseThreadsResult {
  const hydrated = useThreadsStore((s) => s.hydrated)
  const threadsById = useThreadsStore((s) => s.threads)

  // Restrict to the threads anchored to this slug. Legacy threads
  // without `parentSlug` (carried over from the Y.Array layout) are
  // surfaced nowhere — they show as orphaned in the file system and
  // can be reattached or deleted manually. New threads always carry
  // the field because `createThread` below sets it.
  const threads = useMemo(() => {
    if (!slug) return []
    return Object.values(threadsById).filter((t) => t.parentSlug === slug)
  }, [threadsById, slug])

  const createThread = useCallback<UseThreadsResult['createThread']>(
    (initialTitle = '') => {
      if (!slug) return null
      const activeCount = threads.filter((t) => !t.archived).length
      if (activeCount >= MAX_ACTIVE_THREADS) return null

      const now = Date.now()
      const meta: ThreadMeta = {
        id: crypto.randomUUID(),
        parentSlug: slug,
        title: initialTitle,
        createdAt: now,
        updatedAt: now,
        archived: false,
        model: DEFAULT_CHAT_MODEL,
        effort: DEFAULT_CHAT_EFFORT,
      }
      // Fire-and-forget disk write — the in-memory state is updated
      // synchronously by createThread so the UI sees the new thread
      // immediately. Errors surface in the console; the user can
      // retry from the UI.
      void useThreadsStore.getState().createThread(meta)
      return meta.id
    },
    [slug, threads],
  )

  const archiveThread = useCallback<UseThreadsResult['archiveThread']>(
    (id) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.archived) return
      // Cancel any in-flight runs owned by this thread BEFORE marking
      // it archived. This is the canonical lifecycle hook — every
      // caller of archiveThread benefits, regardless of which UI
      // path triggered it.
      useChatRuns.getState().abortByThread(id)
      void useThreadsStore.getState().updateMeta(id, {
        archived: true,
        archivedAt: Date.now(),
      })
    },
    [],
  )

  const restoreThread = useCallback<UseThreadsResult['restoreThread']>(
    (id) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur) return { ok: false, reason: 'not-found' }
      if (!cur.archived) return { ok: true }
      const activeCount = threads.filter((t) => !t.archived).length
      if (activeCount >= MAX_ACTIVE_THREADS) return { ok: false, reason: 'limit' }
      void useThreadsStore.getState().updateMeta(id, {
        archived: false,
        archivedAt: undefined,
        updatedAt: Date.now(),
      })
      return { ok: true }
    },
    [threads],
  )

  const renameThread = useCallback<UseThreadsResult['renameThread']>(
    (id, title) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.title === title) return
      void useThreadsStore.getState().updateMeta(id, {
        title,
        updatedAt: Date.now(),
      })
    },
    [],
  )

  const setThreadModel = useCallback<UseThreadsResult['setThreadModel']>(
    (id, model) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.model === model) return
      void useThreadsStore.getState().updateMeta(id, {
        model,
        updatedAt: Date.now(),
      })
    },
    [],
  )

  const setThreadEffort = useCallback<UseThreadsResult['setThreadEffort']>(
    (id, effort) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.effort === effort) return
      void useThreadsStore.getState().updateMeta(id, {
        effort,
        updatedAt: Date.now(),
      })
    },
    [],
  )

  const markSessionStarted = useCallback<UseThreadsResult['markSessionStarted']>(
    (id) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.sessionStarted) return
      void useThreadsStore.getState().updateMeta(id, { sessionStarted: true })
    },
    [],
  )

  const { active, archived } = useMemo(() => {
    const a: ThreadMeta[] = []
    const r: ThreadMeta[] = []
    for (const t of threads) (t.archived ? r : a).push(t)
    r.sort((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0))
    return { active: a, archived: r }
  }, [threads])

  return {
    ready: hydrated && !!slug,
    threads,
    active,
    archived,
    createThread,
    archiveThread,
    restoreThread,
    renameThread,
    setThreadModel,
    setThreadEffort,
    markSessionStarted,
  }
}
