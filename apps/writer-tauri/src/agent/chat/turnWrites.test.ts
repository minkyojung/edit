import { describe, expect, it, vi } from 'vitest'
import { createTurnWrites } from './turnWrites'

describe('turnWrites', () => {
  // Both answers, because the one that matters is the empty one — a turn that
  // only talked — and a reading that always said "wrote something" would still
  // pass a test that checked only the other.
  it('knows whether the turn wrote to anything', () => {
    const writes = createTurnWrites()
    expect(writes.isEmpty()).toBe(true)

    writes.aboutToWrite('a', () => '턴 이전')
    expect(writes.isEmpty()).toBe(false)
  })

  it('remembers what a note held FIRST, not what the turn last put there', () => {
    const writes = createTurnWrites()
    writes.aboutToWrite('a', () => '턴 이전')
    writes.aboutToWrite('a', () => '모델의 첫 초안')

    expect(writes.before()).toEqual([['a', '턴 이전']])
  })

  // The reason `aboutToWrite` takes a thunk. A turn writing one file repeatedly
  // should cost one read of it, not one per write — and reading the body is not
  // free (it can pull from a mounted editor).
  it('reads a twice-written note only once', () => {
    const read = vi.fn(() => '')
    const writes = createTurnWrites()
    for (let i = 0; i < 3; i++) writes.aboutToWrite('a', read)

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('returns notes in slug order whichever was written first', () => {
    const one = createTurnWrites()
    one.aboutToWrite('b', () => '')
    one.aboutToWrite('a', () => '')

    const other = createTurnWrites()
    other.aboutToWrite('a', () => '')
    other.aboutToWrite('b', () => '')

    expect(one.before()).toEqual(other.before())
    expect(one.before().map(([slug]) => slug)).toEqual(['a', 'b'])
  })

  it('a turn that wrote nothing has nothing to review', () => {
    expect(createTurnWrites().before()).toEqual([])
  })

  // '' is what a not-yet-existing note reads as, and it must be RECORDED rather
  // than skipped: "there was nothing here" is the answer, and a later call that
  // found content would otherwise overwrite it and claim the turn started from
  // text it never saw.
  it('records an empty body as a real answer, not as a missing one', () => {
    const writes = createTurnWrites()
    writes.aboutToWrite('new-note', () => '')
    writes.aboutToWrite('new-note', () => '모델이 방금 쓴 내용')

    expect(writes.isEmpty()).toBe(false)
    expect(writes.before()).toEqual([['new-note', '']])
  })
})
