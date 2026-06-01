import { describe, expect, it } from 'vitest'
import type { KnownDoc } from '@/state/docsStore'
import { metaPathForDoc, pathForDoc, sanitizeFilename } from './docPaths'

function known(partial: Partial<KnownDoc> & { type: KnownDoc['type'] }): KnownDoc {
  return {
    slug: partial.slug ?? 'test-slug',
    type: partial.type,
    date: partial.date,
    title: partial.title,
    parentId: partial.parentId,
  }
}

function lookupFrom(docs: KnownDoc[]): (slug: string) => KnownDoc | undefined {
  return (slug) => docs.find((d) => d.slug === slug)
}

describe('pathForDoc', () => {
  it('places daily entries under daily/ by ISO date', () => {
    expect(pathForDoc(known({ type: 'daily', date: '2026-05-17' }))).toBe(
      'daily/2026-05-17.md',
    )
  })

  it('returns null for daily without a date', () => {
    expect(pathForDoc(known({ type: 'daily' }))).toBeNull()
  })

  it('places wiki:custom pages under wiki/ by title', () => {
    expect(
      pathForDoc(known({ type: 'wiki:custom-abc', title: 'Tom' })),
    ).toBe('wiki/Tom.md')
  })

  it('falls back to Untitled for blank-titled wiki pages', () => {
    expect(pathForDoc(known({ type: 'wiki:custom-abc', title: '   ' }))).toBe(
      'wiki/Untitled.md',
    )
    expect(pathForDoc(known({ type: 'wiki:custom-abc' }))).toBe('wiki/Untitled.md')
  })

  it('sanitises reserved filesystem characters in wiki titles', () => {
    expect(
      pathForDoc(known({ type: 'wiki:custom-abc', title: 'Tom / Boston' })),
    ).toBe('wiki/Tom - Boston.md')
  })

  it('places system pages under _system/ by the type suffix', () => {
    expect(pathForDoc(known({ type: 'system:conventions' }))).toBe(
      '_system/conventions.md',
    )
    expect(pathForDoc(known({ type: 'system:log' }))).toBe(
      '_system/log.md',
    )
    expect(pathForDoc(known({ type: 'system:index' }))).toBe(
      '_system/index.md',
    )
  })

  it('keeps Korean / non-ASCII wiki titles intact', () => {
    expect(
      pathForDoc(known({ type: 'wiki:custom-abc', title: '카파시' })),
    ).toBe('wiki/카파시.md')
  })

  it('places writing notes under their daily ancestor folder', () => {
    const daily = known({ slug: 'd1', type: 'daily', date: '2026-05-18' })
    const note = known({
      slug: 'n1',
      type: 'writing',
      title: 'My note',
      parentId: 'd1',
    })
    expect(pathForDoc(note, lookupFrom([daily, note]))).toBe(
      'daily/2026-05-18/My note.md',
    )
  })

  it('flattens nested writings under the same daily folder', () => {
    const daily = known({ slug: 'd1', type: 'daily', date: '2026-05-18' })
    const parent = known({
      slug: 'p1',
      type: 'writing',
      title: 'Parent',
      parentId: 'd1',
    })
    const child = known({
      slug: 'c1',
      type: 'writing',
      title: 'Child',
      parentId: 'p1',
    })
    expect(pathForDoc(child, lookupFrom([daily, parent, child]))).toBe(
      'daily/2026-05-18/Child.md',
    )
  })

  it('returns null for orphan writing (no daily ancestor)', () => {
    const note = known({
      slug: 'n1',
      type: 'writing',
      title: 'Orphan',
    })
    expect(pathForDoc(note, lookupFrom([note]))).toBeNull()
  })

  it('returns null for writing when no lookup is provided', () => {
    const note = known({ slug: 'n1', type: 'writing', title: 'No lookup' })
    expect(pathForDoc(note)).toBeNull()
  })

  it('places articles under articles/ by title', () => {
    expect(
      pathForDoc(known({ type: 'article', title: 'A Recipe for Training' })),
    ).toBe('articles/A Recipe for Training.md')
  })

  it('sanitises reserved characters in article titles', () => {
    expect(
      pathForDoc(known({ type: 'article', title: 'URL: https://example.com' })),
    ).toBe('articles/URL- https---example.com.md')
  })

  it('falls back to Untitled for blank-titled articles', () => {
    expect(pathForDoc(known({ type: 'article', title: '   ' }))).toBe(
      'articles/Untitled.md',
    )
    expect(pathForDoc(known({ type: 'article' }))).toBe('articles/Untitled.md')
  })
})

describe('metaPathForDoc', () => {
  it('mirrors the body path with .meta.json suffix', () => {
    expect(metaPathForDoc(known({ type: 'daily', date: '2026-05-17' }))).toBe(
      'daily/2026-05-17.meta.json',
    )
    expect(
      metaPathForDoc(known({ type: 'wiki:custom-abc', title: 'Tom' })),
    ).toBe('wiki/Tom.meta.json')
  })

  it('returns null when the body path is null', () => {
    expect(metaPathForDoc(known({ type: 'daily' }))).toBeNull()
  })
})

describe('sanitizeFilename', () => {
  it('replaces forward slash', () => {
    expect(sanitizeFilename('Tom / Boston')).toBe('Tom - Boston')
  })

  it('replaces every fs-reserved character', () => {
    expect(sanitizeFilename('a:b*c?"d<e>f|g\\h/i')).toBe('a-b-c--d-e-f-g-h-i')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeFilename('  hello  ')).toBe('hello')
  })

  it('returns Untitled for empty or whitespace-only input', () => {
    expect(sanitizeFilename('')).toBe('Untitled')
    expect(sanitizeFilename('   ')).toBe('Untitled')
  })

  it('preserves capitalisation', () => {
    expect(sanitizeFilename('Tom')).toBe('Tom')
  })

  it('preserves Hangul / non-ASCII characters', () => {
    expect(sanitizeFilename('카파시')).toBe('카파시')
  })
})
