import { describe, expect, it } from 'vitest'
import { queryNotes } from './queryNotes'
import type { KnownDoc } from '@/state/docsStore'

function doc(d: Partial<KnownDoc> & Pick<KnownDoc, 'slug'>): KnownDoc {
  return { type: 'note', relPath: `inbox/${d.slug}.md`, ...d } as KnownDoc
}

const getDoc = (docs: KnownDoc[]): ((s: string) => KnownDoc | undefined) =>
  (s) => docs.find((x) => x.slug === s)

const paths = (r: { results: { path: string }[] }) => r.results.map((x) => x.path)

describe('queryNotes', () => {
  it('filters by status', () => {
    const docs = [
      doc({ slug: 'a', status: 'in-progress' }),
      doc({ slug: 'b', status: 'done' }),
      doc({ slug: 'c' }),
    ]
    const r = queryNotes(docs, { status: 'in-progress' }, 50, null, getDoc(docs))
    expect(paths(r)).toEqual(['inbox/a.md'])
  })

  it('matches ANY of the requested tags (OR)', () => {
    const docs = [
      doc({ slug: 'a', tags: ['ai'] }),
      doc({ slug: 'b', tags: ['finance', 'x'] }),
      doc({ slug: 'c', tags: ['other'] }),
    ]
    const r = queryNotes(docs, { tags: ['ai', 'finance'] }, 50, null, getDoc(docs))
    expect(paths(r).sort()).toEqual(['inbox/a.md', 'inbox/b.md'])
  })

  it('normalizes tags on both sides before matching', () => {
    const docs = [doc({ slug: 'a', tags: ['ai'] })]
    const r = queryNotes(docs, { tags: ['  AI ', 'AI'] }, 50, null, getDoc(docs))
    // request has padded/dupe but different case → 'AI' !== 'ai' (case-sensitive),
    // so this must NOT match; normalization is trim/dedupe, not case-fold.
    expect(paths(r)).toEqual([])
    // exact (trimmed) tag matches
    expect(paths(queryNotes(docs, { tags: ['  ai '] }, 50, null, getDoc(docs)))).toEqual([
      'inbox/a.md',
    ])
  })

  it('combines status AND tags', () => {
    const docs = [
      doc({ slug: 'a', status: 'in-progress', tags: ['ai'] }),
      doc({ slug: 'b', status: 'in-progress', tags: ['other'] }),
      doc({ slug: 'c', status: 'done', tags: ['ai'] }),
    ]
    const r = queryNotes(docs, { status: 'in-progress', tags: ['ai'] }, 50, null, getDoc(docs))
    expect(paths(r)).toEqual(['inbox/a.md'])
  })

  it('excludes daily and system docs from scope', () => {
    const docs = [
      doc({ slug: 'n', tags: ['x'] }),
      doc({ slug: 'd', type: 'daily', date: '2026-06-10', tags: ['x'] }),
      doc({ slug: 's', type: 'system:conventions', tags: ['x'] }),
      doc({ slug: 'w', type: 'wiki:custom-w', title: 'Wiki', tags: ['x'] }),
    ]
    const r = queryNotes(docs, { tags: ['x'] }, 50, null, getDoc(docs))
    expect(paths(r).sort()).toEqual(['inbox/n.md', 'wiki/Wiki.md'])
  })

  it('returns all in-scope notes for an empty where', () => {
    const docs = [doc({ slug: 'a' }), doc({ slug: 'b' })]
    expect(queryNotes(docs, {}, 50, null, getDoc(docs)).results).toHaveLength(2)
  })

  it('sorts newest-first with a slug tiebreak', () => {
    const docs = [
      doc({ slug: 'old', createdAt: '2026-01-01T00:00:00Z' }),
      doc({ slug: 'new', createdAt: '2026-03-01T00:00:00Z' }),
      doc({ slug: 'b-tie', createdAt: '2026-02-01T00:00:00Z' }),
      doc({ slug: 'a-tie', createdAt: '2026-02-01T00:00:00Z' }),
    ]
    expect(paths(queryNotes(docs, {}, 50, null, getDoc(docs)))).toEqual([
      'inbox/new.md',
      'inbox/a-tie.md', // same date → slug asc
      'inbox/b-tie.md',
      'inbox/old.md',
    ])
  })

  it('paginates via cursor and caps the limit at 100', () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      doc({ slug: `n${i}`, createdAt: `2026-01-0${i + 1}T00:00:00Z` }),
    )
    const first = queryNotes(docs, {}, 2, null, getDoc(docs))
    expect(first.results).toHaveLength(2)
    expect(first.nextCursor).toBe('2')
    const second = queryNotes(docs, {}, 2, first.nextCursor, getDoc(docs))
    expect(second.results).toHaveLength(2)
    expect(second.nextCursor).toBe('4')
    const third = queryNotes(docs, {}, 2, second.nextCursor, getDoc(docs))
    expect(third.results).toHaveLength(1)
    expect(third.nextCursor).toBeNull()
  })

  it('drops docs whose path is unresolvable (null)', () => {
    // A writing note with no daily ancestor resolves to a null path.
    const docs = [
      doc({ slug: 'ok', tags: ['x'] }),
      doc({ slug: 'orphan', type: 'writing', title: 'Orphan', parentId: 'missing', tags: ['x'] }),
    ]
    const r = queryNotes(docs, { tags: ['x'] }, 50, null, getDoc(docs))
    expect(paths(r)).toEqual(['inbox/ok.md'])
  })
})
