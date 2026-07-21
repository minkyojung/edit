import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_STALE_RETRIES,
  __resetModelBaseForTests,
  bumpStale,
  getModelBase,
  resetStale,
  setModelBase,
} from './modelBodyBase'

beforeEach(() => {
  __resetModelBaseForTests()
})

describe('model base tracking', () => {
  it('returns undefined for a never-shown slug (CAS skipped, no false block)', () => {
    expect(getModelBase('never')).toBeUndefined()
  })

  it('records and returns the shown body', () => {
    setModelBase('note', 'hello')
    expect(getModelBase('note')).toBe('hello')
  })

  it('a later stamp overwrites (the model was re-shown)', () => {
    setModelBase('note', 'v1')
    setModelBase('note', 'v2')
    expect(getModelBase('note')).toBe('v2')
  })
})

describe('stale retry governance', () => {
  it('exhausts after MAX_STALE_RETRIES bounces', () => {
    // First MAX_STALE_RETRIES calls stay under budget (ask model to rebase),
    // the next one signals exhaustion (fall back to manual review).
    for (let i = 0; i < MAX_STALE_RETRIES; i++) {
      expect(bumpStale('note')).toBe(false)
    }
    expect(bumpStale('note')).toBe(true)
  })

  it('resetStale restores the full budget', () => {
    for (let i = 0; i < MAX_STALE_RETRIES; i++) bumpStale('note')
    resetStale('note')
    expect(bumpStale('note')).toBe(false)
  })

  it('counts per slug independently', () => {
    for (let i = 0; i <= MAX_STALE_RETRIES; i++) bumpStale('a')
    expect(bumpStale('b')).toBe(false)
  })
})
