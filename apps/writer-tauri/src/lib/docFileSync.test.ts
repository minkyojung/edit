import { describe, expect, it } from 'vitest'
import { shouldDeferStaleWrite } from './docFileSync'

// A2 hardening regression: the flush stale-path guard. Pins the decision
// that prevents a zombie file when an external move/delete races the
// autosave tick. (The live race is ~50ms wide and not hand-reproducible —
// the autosave interval is 500ms — so this pure decision IS the test.)

describe('shouldDeferStaleWrite', () => {
  it('defers when the catalog path is unchanged but the file vanished (move/delete in flight)', () => {
    expect(shouldDeferStaleWrite('articles/Foo.md', 'articles/Foo.md', false)).toBe(true)
  })

  it('writes normally when the file is still present at the path', () => {
    expect(shouldDeferStaleWrite('articles/Foo.md', 'articles/Foo.md', true)).toBe(false)
  })

  it('does not defer when the catalog path already changed (rename-on-change handles it)', () => {
    // lastWritten (old) !== mdPath (new) → the rename-on-change branch owns
    // this case; the guard must not fire even if the new path is absent.
    expect(shouldDeferStaleWrite('articles/Foo.md', 'inbox/Foo.md', false)).toBe(false)
  })

  it('does not defer a brand-new doc with no prior write (must create its file)', () => {
    expect(shouldDeferStaleWrite(undefined, 'inbox/New.md', false)).toBe(false)
  })
})
