// Transcript order, which is the bug this feature was reported as.
//
// Sending a follow-up while an answer streamed appeared to do nothing. It was
// not dropped — it was appended to the settled turns, and settled turns render
// before `streamingTurn`, so the bubble appeared above the answer being written
// while the user watched the bottom of the panel.
//
// Reversing the last two terms here reproduces that exactly, and before this
// file existed the entire suite stayed green when you did.

import { describe, expect, it } from 'vitest'
import { composeTranscript } from './composeTranscript'
import type { QueuedTurn } from '@/stores/turnState'
import type { ChatTurn } from '@/chat/types'

const t = (id: string, role: ChatTurn['role'] = 'user'): ChatTurn => ({
  id,
  role,
  content: id,
  ts: 0,
})
const q = (id: string): QueuedTurn => ({ turn: t(id) })
const ids = (xs: ChatTurn[]) => xs.map((x) => x.id)

describe('composeTranscript', () => {
  it('is just the settled turns when nothing is in flight', () => {
    expect(ids(composeTranscript([t('a'), t('b')], null, []))).toEqual(['a', 'b'])
  })

  it('puts the streaming answer after the settled turns', () => {
    expect(ids(composeTranscript([t('a')], t('live', 'assistant'), []))).toEqual([
      'a',
      'live',
    ])
  })

  // THE regression. 'queued' must come after 'live', not before it.
  it('puts queued turns AFTER the streaming answer', () => {
    expect(
      ids(composeTranscript([t('a')], t('live', 'assistant'), [q('queued')])),
    ).toEqual(['a', 'live', 'queued'])
  })

  it('keeps several queued turns in the order they were typed', () => {
    expect(
      ids(composeTranscript([], t('live', 'assistant'), [q('one'), q('two')])),
    ).toEqual(['live', 'one', 'two'])
  })

  // The drain runs a queued turn the moment the thread goes idle, and there is a
  // frame where the answer has settled but the promotion hasn't happened yet.
  it('still puts queued turns last when no answer is streaming', () => {
    expect(ids(composeTranscript([t('a')], null, [q('queued')]))).toEqual([
      'a',
      'queued',
    ])
  })

  it('does not mutate the arrays it was handed', () => {
    const turns = [t('a')]
    composeTranscript(turns, t('live', 'assistant'), [q('queued')])
    expect(ids(turns)).toEqual(['a'])
  })
})
