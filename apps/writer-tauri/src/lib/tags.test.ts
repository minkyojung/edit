import { describe, expect, it } from 'vitest'
import { aggregateTags } from './tags'
import type { KnownDoc } from '@/state/docsStore'

function doc(d: Partial<KnownDoc> & Pick<KnownDoc, 'slug'>): KnownDoc {
  return { type: 'note', ...d } as KnownDoc
}

describe('aggregateTags', () => {
  it('returns nothing for docs with no tags', () => {
    expect(aggregateTags([doc({ slug: 'a' }), doc({ slug: 'b' })])).toEqual([])
  })

  it('counts each tag across notes', () => {
    const docs = [
      doc({ slug: 'a', tags: ['ai', 'finance'] }),
      doc({ slug: 'b', tags: ['ai'] }),
      doc({ slug: 'c', tags: ['finance', 'ai'] }),
    ]
    expect(aggregateTags(docs)).toEqual([
      { tag: 'ai', count: 3 },
      { tag: 'finance', count: 2 },
    ])
  })

  it('sorts by count desc, then name asc for ties', () => {
    const docs = [
      doc({ slug: 'a', tags: ['zebra', 'apple', 'common'] }),
      doc({ slug: 'b', tags: ['common'] }),
    ]
    // common(2) first; apple(1) & zebra(1) tie → name asc.
    expect(aggregateTags(docs)).toEqual([
      { tag: 'common', count: 2 },
      { tag: 'apple', count: 1 },
      { tag: 'zebra', count: 1 },
    ])
  })
})
