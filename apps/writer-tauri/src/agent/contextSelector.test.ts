import { describe, expect, it } from 'vitest'
import type { KnownDoc } from '@/state/docsStore'
import { selectHotPagesFrom } from './contextSelector'

function wiki(slug: string, title: string, opts: Partial<KnownDoc> = {}): KnownDoc {
  return {
    slug,
    type: `wiki:custom-${slug}` as KnownDoc['type'],
    title,
    ...opts,
  }
}

function system(slug: string, name: string): KnownDoc {
  return {
    slug,
    type: `system:${name}` as KnownDoc['type'],
    title: name,
  }
}

function fromBodies(map: Record<string, string>) {
  return (slug: string) => map[slug] ?? ''
}

describe('selectHotPagesFrom', () => {
  it('returns matched pages with bodies when the source has wikilinks', () => {
    const catalog = [wiki('a', 'Sarah'), wiki('b', 'Acme')]
    const bodies = {
      a: 'Sarah Kim\n\nVP of Operations.',
      b: 'Acme Corp\n\nQ3 partner.',
    }
    const result = selectHotPagesFrom(
      { dailyBody: 'Met with [[Sarah]] today.' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      slug: 'a',
      title: 'Sarah',
      body: 'Sarah Kim\n\nVP of Operations.',
    })
  })

  it('returns an empty array when the source has no wikilinks', () => {
    const catalog = [wiki('a', 'Sarah')]
    const bodies = { a: 'Sarah Kim, VP.' }
    const result = selectHotPagesFrom(
      { dailyBody: 'Talked to Sarah, she said hi.' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toEqual([])
  })

  it('deduplicates multiple references to the same page', () => {
    const catalog = [wiki('a', 'Sarah Kim')]
    const bodies = { a: 'Sarah Kim, VP.' }
    const result = selectHotPagesFrom(
      { dailyBody: '[[Sarah Kim]] said. [[sarah kim]] said again.' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a')
  })

  it('skips archived targets', () => {
    const catalog = [
      wiki('a', 'Sarah', { archivedAt: 1700000000000 }),
      wiki('b', 'Acme'),
    ]
    const bodies = { a: 'archived', b: 'Acme body' }
    const result = selectHotPagesFrom(
      { dailyBody: '[[Sarah]] and [[Acme]]' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('b')
  })

  it('skips system:* targets even when referenced', () => {
    const catalog = [system('cv', 'Conventions'), wiki('a', 'Sarah')]
    const bodies = { cv: 'system body', a: 'Sarah body' }
    const result = selectHotPagesFrom(
      { dailyBody: 'see [[Conventions]] and [[Sarah]]' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a')
  })

  it('skips pages whose body reader returns an empty string', () => {
    const catalog = [wiki('a', 'Sarah'), wiki('b', 'Acme')]
    const bodies = { a: '', b: 'Acme body' }
    const result = selectHotPagesFrom(
      { dailyBody: '[[Sarah]] and [[Acme]]' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('b')
  })

  it('drops the lowest-rank candidate first when over budget', () => {
    // Sarah has 0 backlinks, Acme has 2 (referenced from c and d)
    const catalog = [
      wiki('s', 'Sarah'),
      wiki('a', 'Acme'),
      wiki('c', 'C'),
      wiki('d', 'D'),
    ]
    const bodies = {
      s: 'A'.repeat(60),
      a: 'B'.repeat(60),
      c: 'see [[Acme]]',
      d: 'cite [[Acme]]',
    }
    // Budget fits one page of 60 chars but not two.
    const result = selectHotPagesFrom(
      { dailyBody: '[[Sarah]] [[Acme]]' },
      catalog,
      fromBodies(bodies),
      { budgetChars: 60 },
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a') // Acme survives (rank 2 > rank 0)
  })

  it('respects budget across multiple candidates', () => {
    const catalog = [wiki('a', 'A'), wiki('b', 'B'), wiki('c', 'C')]
    const bodies = {
      a: 'AAAA',
      b: 'BBBB',
      c: 'CCCC',
    }
    // Budget fits two pages but not three.
    const result = selectHotPagesFrom(
      { dailyBody: '[[A]] [[B]] [[C]]' },
      catalog,
      fromBodies(bodies),
      { budgetChars: 8 },
    )
    expect(result).toHaveLength(2)
  })

  it('matches wikilink titles case-insensitively', () => {
    const catalog = [wiki('a', 'Sarah Kim')]
    const bodies = { a: 'body' }
    const result = selectHotPagesFrom(
      { dailyBody: '[[sarah kim]] and [[SARAH KIM]]' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a')
  })

  it('works when the source is a queryText instead of dailyBody', () => {
    const catalog = [wiki('a', 'Sarah')]
    const bodies = { a: 'Sarah body' }
    const result = selectHotPagesFrom(
      { queryText: 'what does [[Sarah]] do?' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a')
  })

  it('returns an empty array for an empty source', () => {
    const catalog = [wiki('a', 'Sarah')]
    const bodies = { a: 'body' }
    expect(selectHotPagesFrom({}, catalog, fromBodies(bodies))).toEqual([])
    expect(
      selectHotPagesFrom({ dailyBody: '   ' }, catalog, fromBodies(bodies)),
    ).toEqual([])
  })

  it('handles wikilinks pointing at non-existent titles silently', () => {
    const catalog = [wiki('a', 'Sarah')]
    const bodies = { a: 'Sarah body' }
    const result = selectHotPagesFrom(
      { dailyBody: '[[NonExistent]] and [[Sarah]]' },
      catalog,
      fromBodies(bodies),
    )
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe('a')
  })
})
