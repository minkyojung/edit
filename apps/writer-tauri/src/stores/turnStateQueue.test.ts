// The queue of turns typed while an answer was still streaming.
//
// Why it is a third state and not just an early append: ChatPanel renders
// `[...turns, streamingTurn, ...queued]`, and a settled turn sorts ABOVE the
// answer being written. Pushing a queued message into `turns` therefore dropped
// it into the middle of the transcript while the user was watching the bottom,
// which read as the message being swallowed.
//
// Ordering and single-delivery are the two properties the drain depends on: the
// effect in ChatPanel can fire more than once for one idle transition, and a
// dequeue that handed the same turn to two callers would run it twice.

import { beforeEach, describe, expect, it } from 'vitest'
import { useTurnState, type QueuedTurn } from './turnState'
import type { ChatTurn } from '@/chat/types'

const T = 'thread-1'
const turn = (id: string): ChatTurn => ({ id, role: 'user', content: id, ts: 0 })
const item = (id: string, over: Partial<QueuedTurn> = {}): QueuedTurn => ({
  turn: turn(id),
  ...over,
})
const queued = () => useTurnState.getState().byThread.get(T)?.queued ?? []

beforeEach(() => {
  useTurnState.setState({ byThread: new Map() })
})

describe('turn queue', () => {
  it('starts empty and returns null rather than throwing', () => {
    expect(queued()).toEqual([])
    expect(useTurnState.getState().dequeueTurn(T)).toBeNull()
  })

  it('drains oldest-first', () => {
    const s = useTurnState.getState()
    s.enqueueTurn(T, item('a'))
    s.enqueueTurn(T, item('b'))
    expect(queued().map((q) => q.turn.id)).toEqual(['a', 'b'])
    expect(useTurnState.getState().dequeueTurn(T)?.turn.id).toBe('a')
    expect(useTurnState.getState().dequeueTurn(T)?.turn.id).toBe('b')
    expect(useTurnState.getState().dequeueTurn(T)).toBeNull()
  })

  // The drain effect is keyed on chatStatus and queue length, and React can run
  // it twice for one transition. What makes that safe is that dequeue REMOVES as
  // it returns, so the second call sees an empty queue. (This does not exercise
  // interleaving — zustand's set is synchronous, so two calls cannot overlap.)
  it('removes as it returns, so a second drain gets nothing', () => {
    useTurnState.getState().enqueueTurn(T, item('a'))
    const first = useTurnState.getState().dequeueTurn(T)
    const second = useTurnState.getState().dequeueTurn(T)
    expect(first?.turn.id).toBe('a')
    expect(second).toBeNull()
  })

  // These do not live on ChatTurn, so if they didn't travel with it a queued
  // message would silently lose its attachments between typing and running.
  it('carries the run arguments through the queue', () => {
    const attachments = [{ name: 'a.png' }] as unknown as QueuedTurn['attachments']
    useTurnState
      .getState()
      .enqueueTurn(T, item('a', { attachments, mentionPaths: ['wiki/Note.md'] }))
    const out = useTurnState.getState().dequeueTurn(T)
    expect(out?.attachments).toBe(attachments)
    expect(out?.mentionPaths).toEqual(['wiki/Note.md'])
  })

  it('keeps queues per thread', () => {
    const s = useTurnState.getState()
    s.enqueueTurn(T, item('a'))
    s.enqueueTurn('thread-2', item('b'))
    expect(useTurnState.getState().dequeueTurn(T)?.turn.id).toBe('a')
    expect(useTurnState.getState().dequeueTurn('thread-2')?.turn.id).toBe('b')
  })

  // The queue shares ThreadTurnState with the streaming buffer; spreading the
  // wrong way round would clear one while writing the other.
  it('does not disturb the streaming turn or status', () => {
    const s = useTurnState.getState()
    s.setStatus(T, 'streaming')
    s.setStreamingTurn(T, turn('assistant'))
    s.enqueueTurn(T, item('a'))
    const st = useTurnState.getState().byThread.get(T)
    expect(st?.status).toBe('streaming')
    expect(st?.streamingTurn?.id).toBe('assistant')
    useTurnState.getState().dequeueTurn(T)
    const after = useTurnState.getState().byThread.get(T)
    expect(after?.status).toBe('streaming')
    expect(after?.streamingTurn?.id).toBe('assistant')
  })
})
