// Guards the flush write-window race: an edit that lands while the flush is
// mid-write (between serialize and the final clearDirty) must NOT have its
// dirty bit wiped, or it is silently never persisted. The generation guard
// (captureDirtyGeneration + clearDirtyIfUnchanged) is the fix.
import { describe, it, expect, afterEach } from 'vitest'
import {
  markSlugDirty,
  clearDirty,
  isDirty,
  captureDirtyGeneration,
  clearDirtyIfUnchanged,
} from './docFileSync'

describe('docFileSync dirty-generation guard', () => {
  afterEach(() => {
    clearDirty('s-race')
    clearDirty('s-clean')
  })

  it('keeps the slug dirty when a new edit lands during the write window', () => {
    markSlugDirty('s-race') // initial edit → dirty
    const gen = captureDirtyGeneration('s-race') // flush captures before serialize
    markSlugDirty('s-race') // a NEW edit arrives while the write is in flight
    clearDirtyIfUnchanged('s-race', gen) // flush completes its (now stale) write
    expect(isDirty('s-race')).toBe(true) // new edit is NOT dropped
  })

  it('clears the slug when nothing changed during the write window', () => {
    markSlugDirty('s-clean')
    const gen = captureDirtyGeneration('s-clean')
    clearDirtyIfUnchanged('s-clean', gen)
    expect(isDirty('s-clean')).toBe(false)
  })
})
