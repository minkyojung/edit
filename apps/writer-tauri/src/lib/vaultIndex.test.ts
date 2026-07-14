import { describe, expect, it } from 'vitest'
import {
  emptyVaultIndex,
  getEntry,
  parseVaultIndex,
  rekeyEntry,
  removeEntry,
  serializeVaultIndex,
  setEntry,
  upsertEntry,
  type VaultIndex,
} from './vaultIndex'

describe('parseVaultIndex', () => {
  it('reads entries with slug + soft state', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: {
        'wiki/A.md': { slug: 'aaa11111', aiSummary: 'about A', aiImportance: 42 },
      },
    })
    expect(parseVaultIndex(raw)).toEqual({
      version: 1,
      entries: {
        'wiki/A.md': { slug: 'aaa11111', aiSummary: 'about A', aiImportance: 42 },
      },
    })
  })

  it('returns an empty index for corrupt JSON', () => {
    expect(parseVaultIndex('{not json')).toEqual(emptyVaultIndex())
  })

  it('returns an empty index when entries is missing or wrong-typed', () => {
    expect(parseVaultIndex('{}')).toEqual(emptyVaultIndex())
    expect(parseVaultIndex('{"entries":[]}')).toEqual(emptyVaultIndex())
  })

  it('drops records without a usable slug', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: {
        'good.md': { slug: 'ok111111' },
        'noSlug.md': { aiImportance: 1 },
        'emptySlug.md': { slug: '' },
      },
    })
    expect(parseVaultIndex(raw).entries).toEqual({ 'good.md': { slug: 'ok111111' } })
  })

  it('ignores fields of the wrong type instead of trusting them', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: { 'a.md': { slug: 's1234567', aiImportance: 'nope', aiSummary: 5 } },
    })
    expect(parseVaultIndex(raw).entries['a.md']).toEqual({ slug: 's1234567' })
  })
})

describe('serialize → parse round-trip', () => {
  it('preserves the index', () => {
    const index: VaultIndex = {
      version: 1,
      entries: {
        'daily/2026-01-01.md': { slug: 'day00001' },
        'wiki/B.md': {
          slug: 'bbb22222',
          aiSummary: 'about B',
          aiImportance: 10,
        },
      },
    }
    expect(parseVaultIndex(serializeVaultIndex(index))).toEqual(index)
  })

  it('emits pretty JSON with a trailing newline', () => {
    const out = serializeVaultIndex(emptyVaultIndex())
    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain('\n  ')
  })
})

describe('pure mutators are immutable', () => {
  const base: VaultIndex = {
    version: 1,
    entries: { 'a.md': { slug: 'aaa00000' } },
  }

  it('setEntry upserts without touching the input', () => {
    const next = setEntry(base, 'b.md', { slug: 'bbb00000' })
    expect(next.entries).toEqual({
      'a.md': { slug: 'aaa00000' },
      'b.md': { slug: 'bbb00000' },
    })
    expect(base.entries).toEqual({ 'a.md': { slug: 'aaa00000' } }) // unchanged
  })

  it('getEntry returns the record or undefined', () => {
    expect(getEntry(base, 'a.md')).toEqual({ slug: 'aaa00000' })
    expect(getEntry(base, 'missing.md')).toBeUndefined()
  })

  it('removeEntry drops the path and is a no-op when absent', () => {
    expect(removeEntry(base, 'a.md').entries).toEqual({})
    expect(removeEntry(base, 'missing.md')).toBe(base) // same ref, no churn
  })
})

describe('upsertEntry (field-level merge, two independent writers)', () => {
  it('creates an entry when the path is new', () => {
    const next = upsertEntry(emptyVaultIndex(), 'a.md', { slug: 'aaa11111' })
    expect(next.entries['a.md']).toEqual({ slug: 'aaa11111' })
  })

  it('preserves fields the patch does not mention', () => {
    // Summary writer sets aiSummary; the importance pass later sets
    // aiImportance. Neither should wipe the other.
    const withSummary = upsertEntry(emptyVaultIndex(), 'a.md', {
      slug: 'aaa11111',
      aiSummary: 'about A',
    })
    const withImportance = upsertEntry(withSummary, 'a.md', {
      slug: 'aaa11111',
      aiImportance: 30,
    })
    expect(withImportance.entries['a.md']).toEqual({
      slug: 'aaa11111',
      aiSummary: 'about A',
      aiImportance: 30,
    })
  })

  it('deletes a field set to undefined', () => {
    const withBoth = upsertEntry(emptyVaultIndex(), 'a.md', {
      slug: 'aaa11111',
      aiImportance: 555,
      aiSummary: 'keep me',
    })
    const cleared = upsertEntry(withBoth, 'a.md', {
      slug: 'aaa11111',
      aiImportance: undefined,
    })
    // aiImportance gone; the summary field (not in the patch) survives.
    expect(cleared.entries['a.md']).toEqual({ slug: 'aaa11111', aiSummary: 'keep me' })
  })

  it('does not mutate the input index', () => {
    const base: VaultIndex = { version: 1, entries: { 'a.md': { slug: 'aaa11111' } } }
    upsertEntry(base, 'a.md', { slug: 'aaa11111', aiImportance: 1 })
    expect(base.entries['a.md']).toEqual({ slug: 'aaa11111' })
  })
})

describe('rekeyEntry (rename / move)', () => {
  const base: VaultIndex = {
    version: 1,
    entries: {
      'wiki/Old.md': { slug: 'keep0001', aiImportance: 7 },
      'other.md': { slug: 'other001' },
    },
  }

  it('moves the record, preserving slug + soft state', () => {
    const next = rekeyEntry(base, 'wiki/Old.md', 'wiki/New.md')
    expect(next.entries['wiki/New.md']).toEqual({ slug: 'keep0001', aiImportance: 7 })
    expect('wiki/Old.md' in next.entries).toBe(false)
    expect(next.entries['other.md']).toEqual({ slug: 'other001' }) // untouched
  })

  it('is a no-op when the source path has no record', () => {
    expect(rekeyEntry(base, 'ghost.md', 'wherever.md')).toBe(base)
  })

  it('is a no-op when source equals destination', () => {
    expect(rekeyEntry(base, 'wiki/Old.md', 'wiki/Old.md')).toBe(base)
  })

  it('overwrites the destination when a move lands on an existing path', () => {
    const next = rekeyEntry(base, 'wiki/Old.md', 'other.md')
    expect(next.entries['other.md']).toEqual({ slug: 'keep0001', aiImportance: 7 })
  })
})
