// Subscribes to the document's `threads` Y.Array and exposes thread CRUD.
//
// Y.Array doesn't have in-place updates, so mutations follow a
// delete-and-insert-at-same-index pattern inside a single transaction.
// That keeps the order stable and lands as one Yjs update on the wire.

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import {
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODEL,
  MAX_ACTIVE_THREADS,
  type ChatEffort,
  type ChatModel,
  type ThreadMeta,
} from '@/chat/types'
import { useChatRuns } from '@/stores/chatRuns'

const THREADS_KEY = 'threads'

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
   * calls short-circuit so we don't spam Yjs updates. */
  markSessionStarted: (id: string) => void
}

export function useThreads(
  ydoc: Y.Doc | null,
  idbSynced: Promise<void> | null,
): UseThreadsResult {
  const [threads, setThreads] = useState<ThreadMeta[]>([])
  // Tracks IDB hydration completion. `ready` must wait on this so callers
  // (e.g. ChatPanel's auto-create effect) don't see a transient empty
  // thread list before persisted threads land — which would otherwise
  // produce a spurious blank thread on every doc open.
  const [idbReady, setIdbReady] = useState(false)

  useEffect(() => {
    setIdbReady(false)
    if (!idbSynced) return
    let cancelled = false
    idbSynced.then(() => {
      if (!cancelled) setIdbReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [idbSynced])

  useEffect(() => {
    if (!ydoc) {
      setThreads([])
      return
    }
    const yThreads = ydoc.getArray<ThreadMeta>(THREADS_KEY)
    const sync = () => setThreads(yThreads.toArray())
    sync()
    yThreads.observe(sync)
    return () => yThreads.unobserve(sync)
  }, [ydoc])

  const findIndex = useCallback(
    (id: string) => {
      if (!ydoc) return -1
      const yThreads = ydoc.getArray<ThreadMeta>(THREADS_KEY)
      return yThreads.toArray().findIndex((t) => t.id === id)
    },
    [ydoc],
  )

  // Replace the entry at `i` with `next` inside one transaction.
  // (Y.Array has no `set` for arbitrary types — delete+insert is the idiom.)
  const replaceAt = useCallback(
    (i: number, next: ThreadMeta) => {
      if (!ydoc) return
      const yThreads = ydoc.getArray<ThreadMeta>(THREADS_KEY)
      // 'chat-meta' origin keeps thread metadata edits out of the
      // doc-body UndoManager. The UndoManager wires its trackedOrigins
      // around content (ySyncPluginKey, mark-action, mark-cleanup);
      // sending Cmd+Z through thread renames / archives / model
      // switches would feel arbitrary to the user and could revert
      // chat state that no longer matches the current run.
      ydoc.transact(() => {
        yThreads.delete(i, 1)
        yThreads.insert(i, [next])
      }, 'chat-meta')
    },
    [ydoc],
  )

  const createThread = useCallback<UseThreadsResult['createThread']>(
    (initialTitle = '') => {
      if (!ydoc) return null
      const yThreads = ydoc.getArray<ThreadMeta>(THREADS_KEY)
      // Block creation when 5 active threads already exist.
      const activeCount = yThreads.toArray().filter((t) => !t.archived).length
      if (activeCount >= MAX_ACTIVE_THREADS) return null

      const now = Date.now()
      const meta: ThreadMeta = {
        id: crypto.randomUUID(),
        title: initialTitle,
        createdAt: now,
        updatedAt: now,
        archived: false,
        model: DEFAULT_CHAT_MODEL,
        effort: DEFAULT_CHAT_EFFORT,
      }
      ydoc.transact(() => yThreads.push([meta]), 'chat-meta')
      return meta.id
    },
    [ydoc],
  )

  const archiveThread = useCallback<UseThreadsResult['archiveThread']>(
    (id) => {
      const i = findIndex(id)
      if (i < 0) return
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (cur.archived) return
      // Cancel any in-flight runs owned by this thread BEFORE marking it
      // archived. This is the canonical lifecycle hook — every caller of
      // archiveThread benefits, regardless of which UI path triggered it.
      useChatRuns.getState().abortByThread(id)
      replaceAt(i, { ...cur, archived: true, archivedAt: Date.now() })
    },
    [findIndex, ydoc, replaceAt],
  )

  const restoreThread = useCallback<UseThreadsResult['restoreThread']>(
    (id) => {
      const i = findIndex(id)
      if (i < 0) return { ok: false, reason: 'not-found' }
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (!cur.archived) return { ok: true }
      const activeCount = yThreads.toArray().filter((t) => !t.archived).length
      if (activeCount >= MAX_ACTIVE_THREADS) return { ok: false, reason: 'limit' }
      const { archivedAt: _archivedAt, ...rest } = cur
      void _archivedAt
      replaceAt(i, { ...rest, archived: false, updatedAt: Date.now() })
      return { ok: true }
    },
    [findIndex, ydoc, replaceAt],
  )

  const renameThread = useCallback<UseThreadsResult['renameThread']>(
    (id, title) => {
      const i = findIndex(id)
      if (i < 0) return
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (cur.title === title) return
      replaceAt(i, { ...cur, title, updatedAt: Date.now() })
    },
    [findIndex, ydoc, replaceAt],
  )

  const setThreadModel = useCallback<UseThreadsResult['setThreadModel']>(
    (id, model) => {
      const i = findIndex(id)
      if (i < 0) return
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (cur.model === model) return
      replaceAt(i, { ...cur, model, updatedAt: Date.now() })
    },
    [findIndex, ydoc, replaceAt],
  )

  const setThreadEffort = useCallback<UseThreadsResult['setThreadEffort']>(
    (id, effort) => {
      const i = findIndex(id)
      if (i < 0) return
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (cur.effort === effort) return
      replaceAt(i, { ...cur, effort, updatedAt: Date.now() })
    },
    [findIndex, ydoc, replaceAt],
  )

  const markSessionStarted = useCallback<UseThreadsResult['markSessionStarted']>(
    (id) => {
      const i = findIndex(id)
      if (i < 0) return
      const yThreads = ydoc!.getArray<ThreadMeta>(THREADS_KEY)
      const cur = yThreads.get(i)
      if (cur.sessionStarted) return
      replaceAt(i, { ...cur, sessionStarted: true })
    },
    [findIndex, ydoc, replaceAt],
  )

  const { active, archived } = useMemo(() => {
    const a: ThreadMeta[] = []
    const r: ThreadMeta[] = []
    for (const t of threads) (t.archived ? r : a).push(t)
    r.sort((x, y) => (y.archivedAt ?? 0) - (x.archivedAt ?? 0))
    return { active: a, archived: r }
  }, [threads])

  return {
    ready: !!ydoc && idbReady,
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
