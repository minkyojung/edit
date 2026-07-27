// The lookups read the fetched catalog first and fall back to the built-in
// tables. These pin BOTH directions: a model this build never heard of gets
// real facts, and an empty/absent catalog changes nothing.

import { afterEach, describe, expect, it } from 'vitest'
import { _resetModelFacts, setModelFacts } from './modelFacts'
import { effortsForModel, labelForModel } from './types'
import { contextLimitForModel } from '@/lib/contextLimit'

afterEach(() => _resetModelFacts())

describe('with no catalog (offline / pre-login)', () => {
  it('falls back to the built-in tables', () => {
    expect(labelForModel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(contextLimitForModel('claude-opus-4-8')).toBe(1_000_000)
    expect(effortsForModel('claude-opus-4-8')).toContain('xhigh')
  })

  it('still degrades safely for an id nobody knows', () => {
    expect(labelForModel('claude-opus-9')).toBe('opus-9')
    expect(contextLimitForModel('claude-opus-9')).toBe(200_000) // conservative
    expect(effortsForModel('claude-opus-9')).toEqual(['low', 'medium', 'high'])
  })
})

describe('with a catalog', () => {
  it('gives a model released after this build real facts', () => {
    setModelFacts([
      {
        id: 'claude-opus-9',
        displayName: 'Claude Opus 9',
        maxInputTokens: 2_000_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ])
    // "Claude " is stripped so it reads like our own labels — see below.
    expect(labelForModel('claude-opus-9')).toBe('Opus 9')
    expect(contextLimitForModel('claude-opus-9')).toBe(2_000_000)
    // `max` is a real tier the API reports but this app deliberately hides.
    expect(effortsForModel('claude-opus-9')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  // The API says "Claude Opus 4.7" where our table says "Opus 4.7"; mixing both
  // in one dropdown reads as two different lists.
  it('drops the API\'s "Claude" prefix so catalog names match our house style', () => {
    setModelFacts([{ id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' }])
    expect(labelForModel('claude-opus-4-7')).toBe('Opus 4.7')
  })

  it('keeps a display name that is only "Claude" rather than rendering empty', () => {
    setModelFacts([{ id: 'claude-mystery', displayName: 'Claude' }])
    expect(labelForModel('claude-mystery')).toBe('Claude')
  })

  it('matches a dated catalog id against the bare id the app sends', () => {
    setModelFacts([{ id: 'claude-haiku-4-5-20251001', maxInputTokens: 200_000 }])
    expect(contextLimitForModel('claude-haiku-4-5')).toBe(200_000)
  })

  // The failure this replaces: an id missing from CONTEXT_LIMITS silently read
  // 200k, so a 1M-window model made the gauge look ~5x too full.
  it('corrects a window the built-in table would under-report', () => {
    expect(contextLimitForModel('claude-future-1')).toBe(200_000)
    setModelFacts([{ id: 'claude-future-1', maxInputTokens: 1_000_000 }])
    expect(contextLimitForModel('claude-future-1')).toBe(1_000_000)
  })

  it('keeps our terser label and curated efforts for models we ship with', () => {
    setModelFacts([
      {
        id: 'claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ])
    expect(labelForModel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(effortsForModel('claude-opus-4-8')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('ignores a catalog row with no usable effort tiers', () => {
    setModelFacts([{ id: 'claude-opus-9', efforts: ['max'] }])
    expect(effortsForModel('claude-opus-9')).toEqual(['low', 'medium', 'high'])
  })
})
