// The per-family version floor.
//
// The catalog lists models this app shouldn't offer — most sharply Opus 4.1,
// which is still returned by /v1/models but is answered by Opus 4.8 (verified
// against the live SDK). A floor drops those without anyone maintaining an
// allowlist, and — the part that matters — without hiding models that don't
// exist yet.

import { describe, expect, it } from 'vitest'
import { meetsVersionFloor, parseModelVersion } from './modelCatalog'

/** The exact ids GET /v1/models returned on 2026-07-27. */
const LIVE_CATALOG = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
] as const

describe('parseModelVersion', () => {
  it('reads family and version segments', () => {
    expect(parseModelVersion('claude-opus-4-8')).toEqual({ family: 'opus', version: [4, 8] })
    expect(parseModelVersion('claude-opus-5')).toEqual({ family: 'opus', version: [5] })
  })

  // Without stripping the date first, 20251001 parses as a third version
  // segment and the model reads as absurdly new.
  it('ignores a release-date suffix', () => {
    expect(parseModelVersion('claude-haiku-4-5-20251001')).toEqual({
      family: 'haiku',
      version: [4, 5],
    })
  })

  it('returns null for shapes it does not recognise', () => {
    expect(parseModelVersion('claude-3-opus-20240229')).toBeNull()
    expect(parseModelVersion('gpt-4')).toBeNull()
  })
})

describe('meetsVersionFloor — against the live catalog', () => {
  it('keeps exactly the eight models worth offering', () => {
    expect(LIVE_CATALOG.filter(meetsVersionFloor)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
    ])
  })

  it('drops the three below their family floor', () => {
    expect(LIVE_CATALOG.filter((id) => !meetsVersionFloor(id))).toEqual([
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      // The model that actually substitutes — the reason this floor exists.
      'claude-opus-4-1-20250805',
    ])
  })

  it('admits a model sitting exactly on its floor', () => {
    expect(meetsVersionFloor('claude-opus-4-6')).toBe(true)
    expect(meetsVersionFloor('claude-sonnet-4-6')).toBe(true)
    expect(meetsVersionFloor('claude-haiku-4-5')).toBe(true)
  })
})

describe('meetsVersionFloor — defaults to showing', () => {
  // The whole point of fetching a catalog is models we haven't heard of. A rule
  // written today must not hide a family invented tomorrow.
  it('passes an unknown family', () => {
    expect(meetsVersionFloor('claude-atlas-1')).toBe(true)
    expect(meetsVersionFloor('claude-fable-5')).toBe(true) // no floor for fable
  })

  it('passes an id it cannot parse', () => {
    expect(meetsVersionFloor('claude-3-opus-20240229')).toBe(true)
    expect(meetsVersionFloor('something-else')).toBe(true)
  })

  it('passes every future version of a floored family', () => {
    for (const id of ['claude-opus-6', 'claude-opus-5-1', 'claude-sonnet-9']) {
      expect(meetsVersionFloor(id)).toBe(true)
    }
  })

  // Read as decimals, 4.10 would sort below 4.8 and a newer model would vanish.
  it('compares segment-wise, not as a decimal number', () => {
    expect(meetsVersionFloor('claude-opus-4-10')).toBe(true)
    expect(meetsVersionFloor('claude-opus-4-5')).toBe(false)
  })
})
