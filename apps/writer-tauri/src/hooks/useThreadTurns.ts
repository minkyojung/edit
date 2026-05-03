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

  return { ready: !!ydoc && !!threadId, turns, appendTurn }
}
