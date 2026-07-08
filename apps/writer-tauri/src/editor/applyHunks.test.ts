// applyHunks — land (possibly edited) green hunks onto the current doc, preserving
// the user's edits outside the frozen old spans (the Cursor-style merge).
import { describe, it, expect } from 'vitest'
import { applyHunks } from './cmHunks'

describe('applyHunks', () => {
  it('replaces a single span with the proposal', () => {
    const doc = 'apple is red.\nbanana is yellow.'
    // replace "apple is red." (0..13) with the proposal
    const out = applyHunks(doc, [{ from: 0, to: 13, after: 'apple is ripe red.' }])
    expect(out).toBe('apple is ripe red.\nbanana is yellow.')
  })

  it('preserves a user edit on another line (merge)', () => {
    // user changed line 2 to "banana is yellow and sweet." (frozen old = line 1 only)
    const userDoc = 'apple is red.\nbanana is yellow and sweet.'
    const out = applyHunks(userDoc, [{ from: 0, to: 13, after: 'apple is ripe red.' }])
    expect(out).toBe('apple is ripe red.\nbanana is yellow and sweet.') // both survive
  })

  it('uses the EDITED green text, not the original', () => {
    const doc = 'apple is red.'
    const out = applyHunks(doc, [{ from: 0, to: 13, after: 'APPLE (user-tweaked)' }])
    expect(out).toBe('APPLE (user-tweaked)')
  })

  it('applies multiple hunks without offset drift', () => {
    const doc = 'one\ntwo\nthree'
    const out = applyHunks(doc, [
      { from: 0, to: 3, after: 'ONE' },
      { from: 8, to: 13, after: 'THREE' },
    ])
    expect(out).toBe('ONE\ntwo\nTHREE')
  })

  it('handles a pure insertion (from === to)', () => {
    const doc = 'ab'
    const out = applyHunks(doc, [{ from: 1, to: 1, after: 'X' }])
    expect(out).toBe('aXb')
  })
})
