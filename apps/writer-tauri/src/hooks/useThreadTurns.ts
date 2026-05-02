// Subscribes to a single thread's turn array (key `thread:<id>`) and
// exposes append/update helpers.
//
// Turn updates (e.g. streaming text deltas) use the same delete+insert
// pattern as useThreads so that Yjs treats each delta as one change.

import { useCallback, useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { ChatTurn } from '@/chat/types'

export interface UseThreadTurnsResult {
  ready: boolean
  turns: ChatTurn[]
  appendTurn: (turn: ChatTurn) => void
  updateTurn: (id: string, patch: Partial<ChatTurn>) => void
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
      ydoc.transact(() => yTurns.push([turn]))
    },
    [ydoc, threadId],
  )

  const updateTurn = useCallback<UseThreadTurnsResult['updateTurn']>(
    (id, patch) => {
      if (!ydoc || !threadId) return
      const yTurns = ydoc.getArray<ChatTurn>(turnsKey(threadId))
      const arr = yTurns.toArray()
      const i = arr.findIndex((t) => t.id === id)
      if (i < 0) return
      ydoc.transact(() => {
        yTurns.delete(i, 1)
        yTurns.insert(i, [{ ...arr[i], ...patch }])
      })
    },
    [ydoc, threadId],
  )

  return { ready: !!ydoc && !!threadId, turns, appendTurn, updateTurn }
}
