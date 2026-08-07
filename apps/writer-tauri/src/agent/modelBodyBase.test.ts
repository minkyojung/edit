import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_STALE_RETRIES,
  __resetModelBaseForTests,
  bumpStale,
  forgetThreadModelBase,
  getModelBase,
  resetStale,
  setModelBase,
} from './modelBodyBase'

beforeEach(() => {
  __resetModelBaseForTests()
})

describe('model base tracking', () => {
  it('returns undefined for a never-shown slug (CAS skipped, no false block)', () => {
    expect(getModelBase('t1', 'never')).toBeUndefined()
  })

  it('records and returns the shown body', () => {
    setModelBase('t1', 'note', 'hello')
    expect(getModelBase('t1', 'note')).toBe('hello')
  })

  it('a later stamp overwrites (the model was re-shown)', () => {
    setModelBase('t1', 'note', 'v1')
    setModelBase('t1', 'note', 'v2')
    expect(getModelBase('t1', 'note')).toBe('v2')
  })

  // The whole point of the key: two conversations editing one note were each
  // shown their own body, and neither may be judged against the other's.
  it('keeps one conversation base per conversation', () => {
    setModelBase('t1', 'note', 'WHAT T1 SAW')
    setModelBase('t2', 'note', 'WHAT T2 SAW')
    expect(getModelBase('t1', 'note')).toBe('WHAT T1 SAW')
    expect(getModelBase('t2', 'note')).toBe('WHAT T2 SAW')
  })

  it('forgets a thread without touching its neighbours', () => {
    setModelBase('t1', 'note', 'BODY')
    setModelBase('t2', 'note', 'BODY')
    forgetThreadModelBase('t1')
    expect(getModelBase('t1', 'note')).toBeUndefined()
    expect(getModelBase('t2', 'note')).toBe('BODY')
  })

  it('forgets a thread stale counters too', () => {
    for (let i = 0; i <= MAX_STALE_RETRIES; i++) bumpStale('t1', 'note')
    forgetThreadModelBase('t1')
    expect(bumpStale('t1', 'note')).toBe(false)
  })

  // Same composite-key hazard the note-context ledger documents: a slug that
  // contains the separator must not be able to impersonate another thread.
  it('does not confuse keys when a slug contains the separator', () => {
    setModelBase('t1', 'a b', 'BODY')
    expect(getModelBase('t1 a', 'b')).toBeUndefined()
  })
})

describe('stale retry governance', () => {
  it('exhausts after MAX_STALE_RETRIES bounces', () => {
    // First MAX_STALE_RETRIES calls stay under budget (ask model to rebase),
    // the next one signals exhaustion (fall back to manual review).
    for (let i = 0; i < MAX_STALE_RETRIES; i++) {
      expect(bumpStale('t1', 'note')).toBe(false)
    }
    expect(bumpStale('t1', 'note')).toBe(true)
  })

  it('resetStale restores the full budget', () => {
    for (let i = 0; i < MAX_STALE_RETRIES; i++) bumpStale('t1', 'note')
    resetStale('t1', 'note')
    expect(bumpStale('t1', 'note')).toBe(false)
  })

  it('counts per slug independently', () => {
    for (let i = 0; i <= MAX_STALE_RETRIES; i++) bumpStale('t1', 'a')
    expect(bumpStale('t1', 'b')).toBe(false)
  })

  // The budget bounds ONE conversation's rebase loop against a user who keeps
  // typing. Sharing it lets a busy conversation spend a quiet one's retries,
  // so the quiet one gives up on its first refusal and reports a write failure
  // that never happened.
  it('counts per conversation independently', () => {
    for (let i = 0; i <= MAX_STALE_RETRIES; i++) bumpStale('t1', 'note')
    expect(bumpStale('t2', 'note')).toBe(false)
  })
})
