// The merge rules that let a model released after ship date appear without a
// new binary — and that guarantee a failed fetch can never take one away.

import { describe, expect, it } from 'vitest'
import { familyKey, mergeModelCatalog, splitByRecency, type ModelEntry } from './modelCatalog'

const entry = (id: string, over: Partial<ModelEntry> = {}): ModelEntry => ({
  id,
  displayName: id,
  createdAt: '2026-01-01T00:00:00Z',
  maxInputTokens: 1_000_000,
  maxTokens: 128_000,
  efforts: ['low', 'medium', 'high'],
  ...over,
})

const SEED = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'] as const

describe('familyKey', () => {
  it('strips a release-date suffix so dated and bare spellings match', () => {
    expect(familyKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(familyKey('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('leaves a version-looking tail that is not a date alone', () => {
    expect(familyKey('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(familyKey('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
})

describe('mergeModelCatalog — additive guarantees', () => {
  it('keeps every built-in model when the catalog is missing', () => {
    for (const catalog of [null, undefined, []] as const) {
      const ids = mergeModelCatalog(SEED, catalog).map((m) => m.id)
      expect(ids.sort()).toEqual([...SEED].sort())
    }
  })

  it('never drops a built-in model the catalog omits', () => {
    // Account can't see Opus 4.8, say — it must still be selectable.
    const merged = mergeModelCatalog(SEED, [entry('claude-sonnet-5')])
    const ids = merged.map((m) => m.id)
    expect(ids).toContain('claude-opus-4-8')
    expect(merged.find((m) => m.id === 'claude-opus-4-8')?.inCatalog).toBe(false)
  })

  // The whole point of the feature.
  it('surfaces a model this build has never heard of', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-opus-9', { displayName: 'Claude Opus 9', createdAt: '2027-01-01T00:00:00Z' }),
    ])
    const found = merged.find((m) => m.id === 'claude-opus-9')
    expect(found).toBeDefined()
    expect(found?.displayName).toBe('Claude Opus 9')
    expect(found?.inCatalog).toBe(true)
    // Newest first, so it leads the picker.
    expect(merged[0].id).toBe('claude-opus-9')
  })
})

describe('mergeModelCatalog — collisions', () => {
  it('does not list a model twice when the catalog spells it with a date', () => {
    const merged = mergeModelCatalog(SEED, [entry('claude-haiku-4-5-20251001')])
    expect(merged.filter((m) => familyKey(m.id) === 'claude-haiku-4-5')).toHaveLength(1)
  })

  it('keeps the seed id (what threads persist) but takes catalog facts', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-haiku-4-5-20251001', {
        displayName: 'Claude Haiku 4.5',
        maxInputTokens: 200_000,
      }),
    ])
    const haiku = merged.find((m) => familyKey(m.id) === 'claude-haiku-4-5')
    expect(haiku?.id).toBe('claude-haiku-4-5') // identity from the seed
    expect(haiku?.displayName).toBe('Claude Haiku 4.5') // facts from the catalog
    expect(haiku?.maxInputTokens).toBe(200_000)
  })
})

describe('mergeModelCatalog — efforts', () => {
  it('narrows to the tiers this app exposes and drops `max`', () => {
    const merged = mergeModelCatalog(['claude-opus-4-8'], [
      entry('claude-opus-4-8', { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }),
    ])
    expect(merged[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('leaves efforts undefined when the catalog has none, so callers keep their table', () => {
    const merged = mergeModelCatalog(['claude-opus-4-8'], [
      entry('claude-opus-4-8', { efforts: [] }),
    ])
    expect(merged[0].efforts).toBeUndefined()
  })
})

describe('splitByRecency', () => {
  it('puts everything up front when there is no catalog', () => {
    const { primary, older } = splitByRecency(mergeModelCatalog(SEED, null), SEED)
    expect(primary.map((m) => m.id).sort()).toEqual([...SEED].sort())
    expect(older).toHaveLength(0)
  })

  it('promotes a model newer than anything this build ships with', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-sonnet-5', { createdAt: '2026-05-01T00:00:00Z' }),
      entry('claude-opus-9', { createdAt: '2027-01-01T00:00:00Z' }),
    ])
    const { primary, older } = splitByRecency(merged, SEED)
    expect(primary.map((m) => m.id)).toContain('claude-opus-9')
    expect(older).toHaveLength(0)
  })

  it('demotes a catalog model older than what we ship with — without dropping it', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-sonnet-5', { createdAt: '2026-05-01T00:00:00Z' }),
      entry('claude-opus-4-1-20250805', { createdAt: '2025-08-05T00:00:00Z' }),
    ])
    const { primary, older } = splitByRecency(merged, SEED)
    expect(older.map((m) => m.id)).toEqual(['claude-opus-4-1-20250805'])
    // Still reachable — an old thread pinned to it must stay selectable.
    expect([...primary, ...older].map((m) => m.id)).toContain('claude-opus-4-1-20250805')
  })

  it('never demotes a built-in model, however old', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-haiku-4-5', { createdAt: '2020-01-01T00:00:00Z' }),
      entry('claude-sonnet-5', { createdAt: '2026-05-01T00:00:00Z' }),
    ])
    const { older } = splitByRecency(merged, SEED)
    expect(older).toHaveLength(0)
  })
})

describe('mergeModelCatalog — ordering', () => {
  it('sorts newest first and keeps built-in order for entries without a date', () => {
    const merged = mergeModelCatalog(SEED, [
      entry('claude-sonnet-5', { createdAt: '2026-05-01T00:00:00Z' }),
      entry('claude-opus-4-8', { createdAt: '2026-06-01T00:00:00Z' }),
    ])
    expect(merged.map((m) => m.id)).toEqual([
      'claude-opus-4-8', // newest dated
      'claude-sonnet-5',
      'claude-haiku-4-5', // undated (catalog didn't cover it) sorts last
    ])
  })
})
