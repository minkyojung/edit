// Subscribes to a single thread's turn array (key `thread:<id>`) and
// exposes append helpers. Turn-level mutation (status changes, streaming
// text) lives in component-local state — Yjs only sees the finished turn,
// which keeps streaming off the network and out of the observer hot path.

import { useCallback, useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { ChatTurn } from '@/chat/types'

export interface UseThreadTurnsResult {
  ready: boolean
  turns: ChatTurn[]
  appendTurn: (turn: ChatTurn) => void
  /** Remove a single turn by id. Used by Regenerate, which deletes the last
   * assistant turn before running a fresh one in its place. No-op if the id
   * is not found. */
  removeTurn: (id: string) => void
}

function turnsKey(threadId: string) {
  return `thread:${threadId}`
}

export function useThreadTurns(
  ydoc: Y.Doc | null,
  threadId: string | null,
): UseThreadTurnsResult {
  const [turns, setTurns] = useState<ChatTurn[]>([])

  useEffect(() => {
    if (!ydoc || !threadId) {
      setTurns([])
      return
    }
    const yTurns = ydoc.getArray<ChatTurn>(turnsKey(threadId))
    const sync = () => setTurns(yTurns.toArray())
    sync()
    yTurns.observe(sync)
    return () => yTurns.unobserve(sync)
  }, [ydoc, threadId])

  const appendTurn = useCallback<UseThreadTurnsResult['appendTurn']>(
    (turn) => {
      if (!ydoc || !threadId) return
      const yTurns = ydoc.getArray<ChatTurn>(turnsKey(threadId))
      // 'chat-meta' origin — same rationale as useThreads' replaceAt:
      // chat turns aren't part of the document undo stack. Sending
      // Cmd+Z through a sent message would feel like the wrong action
      // got an undo handle. The UndoManager's trackedOrigins skips
      // this origin by design.
      ydoc.transact(() => yTurns.push([turn]), 'chat-meta')
    },
    [ydoc, threadId],
  )

  const removeTurn = useCallback<UseThreadTurnsResult['removeTurn']>(
    (id) => {
      if (!ydoc || !threadId) return
      const yTurns = ydoc.getArray<ChatTurn>(turnsKey(threadId))
      const idx = yTurns.toArray().findIndex((t) => t.id === id)
      if (idx < 0) return
      ydoc.transact(() => yTurns.delete(idx, 1), 'chat-meta')
    },
    [ydoc, threadId],
  )

  return { ready: !!ydoc && !!threadId, turns, appendTurn, removeTurn }
}
