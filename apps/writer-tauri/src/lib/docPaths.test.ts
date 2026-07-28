import { describe, expect, it } from 'vitest'
import type { KnownDoc } from '@/state/docsStore'
import {
  metaPathForDoc,
  pathForDoc,
  pathForSlug,
  sanitizeFilename,
  usesFrontmatter,
} from './docPaths'

function known(partial: Partial<KnownDoc> & { type: KnownDoc['type'] }): KnownDoc {
  return {
    slug: partial.slug ?? 'test-slug',
    type: partial.type,
    date: partial.date,
    title: partial.title,
    parentId: partial.parentId,
    relPath: partial.relPath,
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

  it('returns a generic note at its stored relPath verbatim', () => {
    expect(pathForDoc(known({ type: 'note', relPath: 'projects/Memo.md' }))).toBe(
      'projects/Memo.md',
    )
    // Inbox captures (saved pages / youtube) are notes — placement is the
    // relPath set at creation (inbox/<title>.md), returned verbatim.
    expect(
      pathForDoc(known({ type: 'note', relPath: 'inbox/Inside the Mind.md' })),
    ).toBe('inbox/Inside the Mind.md')
    // No relPath → no placement.
    expect(pathForDoc(known({ type: 'note' }))).toBeNull()
  })
})

describe('usesFrontmatter', () => {
  it('is true for every type — all docs are frontmatter-native (no sidecars)', () => {
    expect(usesFrontmatter(known({ type: 'daily' }))).toBe(true)
    expect(usesFrontmatter(known({ type: 'writing' }))).toBe(true)
    expect(usesFrontmatter(known({ type: 'note' }))).toBe(true)
    expect(usesFrontmatter(known({ type: 'wiki:custom-x' }))).toBe(true)
    expect(usesFrontmatter(known({ type: 'system:log' }))).toBe(true)
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

// pathForSlug is what the chat's current-note context and its composer chip
// both resolve through, so a slug that silently resolves to null there means
// "no chip AND no note context" — the two must never disagree.
describe('pathForSlug', () => {
  const docs: KnownDoc[] = [
    known({ slug: 'daily-1', type: 'daily', date: '2026-05-17' }),
    known({ slug: 'wiki-1', type: 'wiki:custom-abc', title: 'Boston' }),
    known({ slug: 'note-1', type: 'note', relPath: 'inbox/clipped.md' }),
    known({ slug: 'child-1', type: 'writing', title: 'Draft', parentId: 'daily-1' }),
  ]

  it('resolves a slug the same way pathForDoc resolves its doc', () => {
    expect(pathForSlug('daily-1', docs)).toBe('daily/2026-05-17.md')
    expect(pathForSlug('wiki-1', docs)).toBe('wiki/Boston.md')
    expect(pathForSlug('note-1', docs)).toBe('inbox/clipped.md')
  })

  // The writing case is the one that needs the catalog for more than the
  // initial lookup: the day folder comes from walking parentId to the daily.
  it('walks a writing doc up to its daily ancestor for the day folder', () => {
    expect(pathForSlug('child-1', docs)).toBe('daily/2026-05-17/Draft.md')
  })

  it('returns null for a null slug or one not in the catalog', () => {
    expect(pathForSlug(null, docs)).toBeNull()
    expect(pathForSlug('nope', docs)).toBeNull()
  })

  it('returns null for a doc with no placement', () => {
    expect(pathForSlug('d', [known({ slug: 'd', type: 'daily' })])).toBeNull()
    expect(pathForSlug('n', [known({ slug: 'n', type: 'note' })])).toBeNull()
  })
})
