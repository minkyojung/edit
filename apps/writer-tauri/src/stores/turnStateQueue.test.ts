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

  // Stop must HOLD the queue, not drain it and not drop it. Draining is what
  // made Stop look broken: the cancel settles the turn, the thread goes idle,
  // and the drain effect starts the next queued message on that transition.
  describe('pause', () => {
    it('is off until Stop asks for it', () => {
      useTurnState.getState().enqueueTurn(T, item('a'))
      expect(useTurnState.getState().byThread.get(T)?.queuePaused).toBe(false)
    })

    it('holds the turns rather than dropping them', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      s.pauseQueue(T)
      const st = useTurnState.getState().byThread.get(T)
      expect(st?.queuePaused).toBe(true)
      // Still there — the bubbles stay on screen, they just don't run.
      expect(st?.queued.map((q) => q.turn.id)).toEqual(['a'])
    })

    it('is released by resumeQueue', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      s.pauseQueue(T)
      useTurnState.getState().resumeQueue(T)
      expect(useTurnState.getState().byThread.get(T)?.queuePaused).toBe(false)
    })

    // Queueing behind a live answer is itself a send. A hold left over from an
    // earlier Stop would strand this turn and everything parked ahead of it.
    it('is released by queueing another turn', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      s.pauseQueue(T)
      useTurnState.getState().enqueueTurn(T, item('b'))
      const st = useTurnState.getState().byThread.get(T)
      expect(st?.queuePaused).toBe(false)
      expect(st?.queued.map((q) => q.turn.id)).toEqual(['a', 'b'])
    })

    it('is per thread', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      s.enqueueTurn('thread-2', item('b'))
      useTurnState.getState().pauseQueue(T)
      expect(useTurnState.getState().byThread.get(T)?.queuePaused).toBe(true)
      expect(useTurnState.getState().byThread.get('thread-2')?.queuePaused).toBe(false)
    })
  })

  describe('remove', () => {
    it('drops just that turn and keeps the order of the rest', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      s.enqueueTurn(T, item('b'))
      s.enqueueTurn(T, item('c'))
      useTurnState.getState().removeQueuedTurn(T, 'b')
      expect(queued().map((q) => q.turn.id)).toEqual(['a', 'c'])
    })

    // The X only renders while a turn is parked, but a click can land on the
    // frame the drain takes it. Removing something already dispatched must not
    // disturb the rest of the queue.
    it('is a no-op for a turn that is no longer queued', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      useTurnState.getState().removeQueuedTurn(T, 'gone')
      expect(queued().map((q) => q.turn.id)).toEqual(['a'])
      useTurnState.getState().removeQueuedTurn('no-such-thread', 'a')
      expect(queued().map((q) => q.turn.id)).toEqual(['a'])
    })

    it('leaves an emptied queue drainable rather than stuck', () => {
      const s = useTurnState.getState()
      s.enqueueTurn(T, item('a'))
      useTurnState.getState().removeQueuedTurn(T, 'a')
      expect(queued()).toEqual([])
      expect(useTurnState.getState().dequeueTurn(T)).toBeNull()
    })
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
