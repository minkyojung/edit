// Headless proof for the save-status reducer (the only custom logic; the
// docChanged signal + placeholder are CM's).

import { describe, expect, it } from 'vitest'
import { initialStatus, bumpRevision, markSaved } from './saveStatus'

describe('save status reducer', () => {
  it('starts clean at rev 0', () => {
    expect(initialStatus).toEqual({ dirty: false, rev: 0 })
  })

  it('an edit marks dirty and bumps the revision', () => {
    const a = bumpRevision(initialStatus)
    expect(a).toEqual({ dirty: true, rev: 1 })
    expect(bumpRevision(a)).toEqual({ dirty: true, rev: 2 })
  })

  it('save clears dirty, keeps the revision', () => {
    expect(markSaved({ dirty: true, rev: 2 })).toEqual({ dirty: false, rev: 2 })
  })
})
