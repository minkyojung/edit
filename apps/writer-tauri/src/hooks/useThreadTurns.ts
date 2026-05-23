// Hook surface for a single thread's turns. Backed by the
// file-based `threadsStore` — appends land in
// `threads/<id>.turns.jsonl`, removes rewrite the file.
//
// Turn-level mutation while a turn is streaming (status flips,
// growing assistant text) stays in component-local state — only
// the finished turn ever reaches this hook + the store. That keeps
// the disk write rate at "one append per assistant settle" rather
// than "one append per stream chunk".

import { useCallback } from 'react'
import type { ChatTurn } from '@/chat/types'
import { useThreadsStore } from '@/state/threadsStore'

export interface UseThreadTurnsResult {
  ready: boolean
  turns: ChatTurn[]
  appendTurn: (turn: ChatTurn) => void
  /** Remove a single turn by id. Used by Regenerate, which deletes
   * the last assistant turn before running a fresh one in its place.
   * No-op if the id is not found. */
  removeTurn: (id: string) => void
}

const EMPTY: ChatTurn[] = []

export function useThreadTurns(threadId: string | null): UseThreadTurnsResult {
  const hydrated = useThreadsStore((s) => s.hydrated)
  const turns = useThreadsStore((s) =>
    threadId ? (s.turns[threadId] ?? EMPTY) : EMPTY,
  )

  const appendTurn = useCallback<UseThreadTurnsResult['appendTurn']>(
    (turn) => {
      if (!threadId) return
      void useThreadsStore.getState().appendTurn(threadId, turn)
    },
    [threadId],
  )

  const removeTurn = useCallback<UseThreadTurnsResult['removeTurn']>(
    (id) => {
      if (!threadId) return
      const current = useThreadsStore.getState().turns[threadId] ?? []
      const next = current.filter((t) => t.id !== id)
      if (next.length === current.length) return
      void useThreadsStore.getState().rewriteTurns(threadId, next)
    },
    [threadId],
  )

  return { ready: hydrated && !!threadId, turns, appendTurn, removeTurn }
}
