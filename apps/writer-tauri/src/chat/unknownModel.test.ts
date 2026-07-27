// Unknown-model safety net.
//
// The set of real Claude models grows outside this repo, so an id we don't list
// reaches us from three directions: a thread persisted before the model was
// added, a persisted setting, and a user-authored slash command. Once the model
// catalog is fetched at runtime it will arrive from a fourth. Every lookup keyed
// by model id must therefore degrade instead of throwing or rendering blank —
// these tests pin that.

import { describe, expect, it } from 'vitest'
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  clampEffort,
  effortsForModel,
  labelForModel,
  normalizeModel,
} from './types'

// An id shaped like a real one but absent from CHAT_MODELS — stands in for "a
// model that shipped after this build".
const UNKNOWN = 'claude-opus-9'

describe('effortsForModel', () => {
  it('returns the real list for a known model', () => {
    expect(effortsForModel('claude-opus-4-8')).toContain('xhigh')
    expect(effortsForModel('claude-haiku-4-5')).not.toContain('xhigh')
  })

  it('falls back to a usable list for an unknown model (never undefined)', () => {
    const efforts = effortsForModel(UNKNOWN)
    expect(efforts.length).toBeGreaterThan(0)
    expect(efforts).toContain('high')
  })
})

describe('clampEffort', () => {
  it('keeps an effort the model supports', () => {
    expect(clampEffort('xhigh', 'claude-opus-4-8')).toBe('xhigh')
  })

  it('snaps down when the model tops out lower', () => {
    expect(clampEffort('xhigh', 'claude-haiku-4-5')).toBe('high')
  })

  // The regression this whole file exists for: clampEffort used to index
  // EFFORTS_BY_MODEL directly, so an unknown id hit `undefined.includes(...)`
  // and threw — taking the chat panel down on render.
  it('does not throw on an unknown model', () => {
    expect(() => clampEffort('xhigh', UNKNOWN)).not.toThrow()
    expect(effortsForModel(UNKNOWN)).toContain(clampEffort('xhigh', UNKNOWN))
  })
})

describe('labelForModel', () => {
  it('uses the friendly label for a known model', () => {
    expect(labelForModel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(labelForModel('claude-opus-5')).toBe('Opus 5')
  })

  it('never renders empty for an unknown model', () => {
    const label = labelForModel(UNKNOWN)
    expect(label).not.toBe('')
    expect(label).toBe('opus-9') // bare id minus the `claude-` prefix
  })
})

describe('normalizeModel', () => {
  it('passes through a currently-offered model', () => {
    for (const m of CHAT_MODELS) expect(normalizeModel(m)).toBe(m)
  })

  it('maps a retired id to its successor', () => {
    expect(normalizeModel('claude-opus-4-7')).toBe('claude-opus-4-8')
  })

  it('falls back to the default for an unknown or missing id', () => {
    expect(normalizeModel(UNKNOWN)).toBe(DEFAULT_CHAT_MODEL)
    expect(normalizeModel(undefined)).toBe(DEFAULT_CHAT_MODEL)
  })
})
