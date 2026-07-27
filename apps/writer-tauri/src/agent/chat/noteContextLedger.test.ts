import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetNoteContextLedgerForTests,
  forgetThreadNoteContext,
  markNoteBodyShown,
  needsNoteBody,
} from './noteContextLedger'

beforeEach(() => {
  __resetNoteContextLedgerForTests()
})

describe('noteContextLedger', () => {
  it('needs the body until it has been shown, then stops', () => {
    expect(needsNoteBody('t1', 'a', 'BODY')).toBe(true)
    markNoteBodyShown('t1', 'a', 'BODY')
    expect(needsNoteBody('t1', 'a', 'BODY')).toBe(false)
  })

  // The whole point of re-sending: the user edited the note between turns, so
  // the copy the model holds is now wrong.
  it('needs the body again once the content changes', () => {
    markNoteBodyShown('t1', 'a', 'BODY')
    expect(needsNoteBody('t1', 'a', 'BODY EDITED')).toBe(true)
  })

  // Sessions are per-thread, so "shown" is per-thread too. Thread B has never
  // seen a word of what thread A was told.
  it('tracks threads independently', () => {
    markNoteBodyShown('t1', 'a', 'BODY')
    expect(needsNoteBody('t2', 'a', 'BODY')).toBe(true)
  })

  it('tracks notes independently', () => {
    markNoteBodyShown('t1', 'a', 'BODY')
    expect(needsNoteBody('t1', 'b', 'BODY')).toBe(true)
  })

  // Switching away and back must NOT re-send: the copy from the earlier turn is
  // still in the conversation, and unchanged.
  it('does not re-send an unchanged note after switching away and back', () => {
    markNoteBodyShown('t1', 'a', 'BODY_A')
    markNoteBodyShown('t1', 'b', 'BODY_B')
    expect(needsNoteBody('t1', 'a', 'BODY_A')).toBe(false)
  })

  it('forgets a thread without touching its neighbours', () => {
    markNoteBodyShown('t1', 'a', 'BODY')
    markNoteBodyShown('t2', 'a', 'BODY')
    forgetThreadNoteContext('t1')
    expect(needsNoteBody('t1', 'a', 'BODY')).toBe(true)
    expect(needsNoteBody('t2', 'a', 'BODY')).toBe(false)
  })

  // The key is a composite; a slug that happens to contain the separator must
  // not be able to impersonate another thread's entry.
  it('does not confuse keys when a slug contains the separator', () => {
    markNoteBodyShown('t1', 'a b', 'BODY')
    expect(needsNoteBody('t1 a', 'b', 'BODY')).toBe(true)
  })
})
