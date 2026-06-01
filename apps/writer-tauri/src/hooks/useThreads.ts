// Hook surface for chat threads. Backed by `threadsStore` — a
// zustand store that mirrors the on-disk `threads/<id>.json` +
// `threads/<id>.turns.jsonl` pair (Phase 4.F file-based layout).
//
// Phase H (Cursor-style threads): threads are GLOBAL. They no
// longer filter by `parentSlug` — the active thread persists
// across page navigation and lives across the whole app. The
// optional `currentSlug` argument only feeds new-thread creation
// so we still stamp the doc the user was on as informational
// provenance; it does NOT affect the returned list.

import { useCallback, useMemo } from 'react'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  MAX_ACTIVE_THREADS,
  type ChatEffort,
  type ChatMode,
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
  createThread: (initialTitle?: string) => Promise<string | null>
  archiveThread: (id: string) => void
  restoreThread: (id: string) => { ok: true } | { ok: false; reason: 'limit' | 'not-found' }
  renameThread: (id: string, title: string) => void
  setThreadModel: (id: string, model: ChatModel) => void
  setThreadEffort: (id: string, effort: ChatEffort) => void
  setThreadMode: (id: string, mode: ChatMode) => void
  setThreadFastMode: (id: string, fastMode: boolean) => void
  /** Marks the thread as having a confirmed SDK session. Called once per
   * thread, on the first stream event of its first run. Idempotent — repeat
   * calls short-circuit so we don't write the same value again. */
  markSessionStarted: (id: string) => void
}

/** Global thread surface. `currentSlug` is purely informational — it
 * stamps `parentSlug` on newly-created threads so the user can see
 * "this conversation started while I was on the X page", but the
 * returned thread list is the same regardless of which page the
 * user is on. */
export function useThreads(currentSlug: string | null = null): UseThreadsResult {
  const hydrated = useThreadsStore((s) => s.hydrated)
  const threadsById = useThreadsStore((s) => s.threads)

  const threads = useMemo(() => Object.values(threadsById), [threadsById])

  const createThread = useCallback<UseThreadsResult['createThread']>(
    async (initialTitle = '') => {
      const activeCount = threads.filter((t) => !t.archived).length
      if (activeCount >= MAX_ACTIVE_THREADS) return null

      const now = Date.now()
      const meta: ThreadMeta = {
        id: crypto.randomUUID(),
        // Informational only post-Phase H. Empty string when the user
        // creates a thread without an active page (rare).
        parentSlug: currentSlug ?? '',
        title: initialTitle,
        createdAt: now,
        updatedAt: now,
        archived: false,
        model: DEFAULT_CHAT_MODEL,
        effort: DEFAULT_CHAT_EFFORT,
      }
      // Await the store update so callers can rely on the new thread
      // being visible in the threads list when this resolves. Without
      // this, useActiveThread's reconcile effect would race the disk
      // write and revert activeId back to the previous thread because
      // the new id isn't in the active list yet.
      await useThreadsStore.getState().createThread(meta)
      return meta.id
    },
    [currentSlug, threads],
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

  const setThreadMode = useCallback<UseThreadsResult['setThreadMode']>(
    (id, mode) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || cur.mode === mode) return
      void useThreadsStore.getState().updateMeta(id, {
        mode,
        updatedAt: Date.now(),
      })
    },
    [],
  )

  const setThreadFastMode = useCallback<UseThreadsResult['setThreadFastMode']>(
    (id, fastMode) => {
      const cur = useThreadsStore.getState().threads[id]
      if (!cur || (cur.fastMode ?? false) === fastMode) return
      void useThreadsStore.getState().updateMeta(id, {
        fastMode,
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
    // Active threads: most recently updated first — Cursor-style "what
    // I was just working on" surface in the picker.
    a.sort((x, y) => y.updatedAt - x.updatedAt)
    r.sort((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0))
    return { active: a, archived: r }
  }, [threads])

  return {
    ready: hydrated,
    threads,
    active,
    archived,
    createThread,
    archiveThread,
    restoreThread,
    renameThread,
    setThreadModel,
    setThreadEffort,
    setThreadMode,
    setThreadFastMode,
    markSessionStarted,
  }
}
