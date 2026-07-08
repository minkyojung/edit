import { describe, expect, it } from 'vitest'
import { classifyModify, planReappear, renameLeg } from './vaultWatcher'

// Regression cover for A2 (external move/rename keeps the open tab alive).
// These pin the three routing decisions that each shipped a real bug; the
// live verification covers the fs-event → store wiring around them.

describe('classifyModify — A: rename vs reload', () => {
  it('routes a rename modify to the move/rename handler', () => {
    // Bug 1: macOS delivers an external move as modify/rename, not
    // create+remove. Misrouting it to reload closed + reopened the tab.
    expect(classifyModify('rename')).toBe('rename')
  })

  it('routes a plain content save to reload', () => {
    expect(classifyModify('data')).toBe('reload')
  })

  it('routes an unknown / missing kind to reload (safe default)', () => {
    expect(classifyModify(undefined)).toBe('reload')
    expect(classifyModify('any')).toBe('reload')
  })
})

describe('renameLeg — B: which leg of a move this path is', () => {
  it('present on disk → destination leg (add)', () => {
    expect(renameLeg(true)).toBe('add')
  })

  it('gone from disk → source leg (remove)', () => {
    expect(renameLeg(false)).toBe('remove')
  })
})

describe('planReappear — C: what to update on a rebuilt doc', () => {
  it('no existing entry → add the brand-new doc', () => {
    expect(planReappear(undefined, { relPath: 'inbox/New.md', title: 'New' })).toEqual({
      kind: 'add',
    })
  })

  it('folder move (same title, new relPath) → update placement only', () => {
    expect(
      planReappear(
        { relPath: 'articles/X.md', title: 'X' },
        { relPath: 'inbox/X.md', title: 'X' },
      ),
    ).toEqual({ kind: 'update', relPath: 'inbox/X.md', title: 'X' })
  })

  it('rename (new filename) → update placement AND label', () => {
    // Bug 2: title is derived from the filename, so a rename must refresh
    // it or the sidebar row keeps the old name.
    expect(
      planReappear(
        { relPath: 'articles/X.md', title: 'X' },
        { relPath: 'articles/Y.md', title: 'Y' },
      ),
    ).toEqual({ kind: 'update', relPath: 'articles/Y.md', title: 'Y' })
  })

  it('echo (same path, same title) → no-op', () => {
    expect(
      planReappear(
        { relPath: 'articles/X.md', title: 'X' },
        { relPath: 'articles/X.md', title: 'X' },
      ),
    ).toEqual({ kind: 'noop' })
  })

  it('blank rebuilt relPath → no-op rather than writing an empty placement', () => {
    expect(
      planReappear({ relPath: 'articles/X.md', title: 'X' }, { relPath: '', title: 'X' }),
    ).toEqual({ kind: 'noop' })
  })
})
