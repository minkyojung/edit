import { describe, expect, it } from 'vitest'
import { buildFileTree, type TreeFolder } from './fileTree'
import type { KnownDoc } from '@/state/docsStore'

function doc(d: Partial<KnownDoc> & Pick<KnownDoc, 'slug' | 'type'>): KnownDoc {
  return d as KnownDoc
}

describe('buildFileTree', () => {
  it('returns an empty tree for no docs', () => {
    expect(buildFileTree([])).toEqual([])
  })

  it('places a wiki page under a wiki/ folder', () => {
    const tree = buildFileTree([doc({ slug: 'w1', type: 'wiki:custom-w1', title: 'Tom' })])
    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'wiki',
        path: 'wiki',
        children: [
          { kind: 'file', name: 'Tom', path: 'wiki/Tom.md', slug: 'w1', type: 'wiki:custom-w1' },
        ],
      },
    ])
  })

  it('places a youtube capture under inbox/', () => {
    const tree = buildFileTree([doc({ slug: 'y1', type: 'youtube', title: 'My Video' })])
    const inbox = tree[0] as TreeFolder
    expect(inbox.name).toBe('inbox')
    expect(inbox.children[0]).toMatchObject({ kind: 'file', name: 'My Video', slug: 'y1' })
  })

  it('renders a daily and its writing child (literal file + folder)', () => {
    const tree = buildFileTree([
      doc({ slug: 'd1', type: 'daily', date: '2026-06-10' }),
      doc({ slug: 'w1', type: 'writing', title: 'Note', parentId: 'd1' }),
    ])
    const daily = tree[0] as TreeFolder
    expect(daily.name).toBe('daily')
    // folders sort before files → the date folder, then the daily file
    expect(daily.children.map((c) => [c.kind, c.name])).toEqual([
      ['folder', '2026-06-10'],
      ['file', '2026-06-10'],
    ])
    const dateFolder = daily.children[0] as TreeFolder
    expect(dateFolder.children[0]).toMatchObject({ kind: 'file', name: 'Note', slug: 'w1' })
  })

  it('drops archived docs', () => {
    const tree = buildFileTree([
      doc({ slug: 'w1', type: 'wiki:custom-w1', title: 'Live' }),
      doc({ slug: 'w2', type: 'wiki:custom-w2', title: 'Gone', archivedAt: 123 }),
    ])
    const wiki = tree[0] as TreeFolder
    expect(wiki.children.map((c) => c.name)).toEqual(['Live'])
  })

  it('drops docs with no placement (a daily without a date)', () => {
    expect(buildFileTree([doc({ slug: 'd1', type: 'daily' })])).toEqual([])
  })

  it('hides `_`-prefixed folders (e.g. _system)', () => {
    const tree = buildFileTree([
      doc({ slug: 's1', type: 'system:conventions' }),
      doc({ slug: 'w1', type: 'wiki:custom-w1', title: 'Tom' }),
    ])
    expect(tree.map((n) => n.name)).toEqual(['wiki']) // no `_system`
  })

  it('sorts folders before files, each alphabetically', () => {
    const tree = buildFileTree([
      doc({ slug: 'a1', type: 'article', title: 'zebra article' }),
      doc({ slug: 'w1', type: 'wiki:custom-w1', title: 'Apple' }),
      doc({ slug: 'w2', type: 'wiki:custom-w2', title: 'banana' }),
    ])
    // top level: folders 'articles' and 'wiki' (alphabetical), no loose files
    expect(tree.map((n) => n.name)).toEqual(['articles', 'wiki'])
    const wiki = tree[1] as TreeFolder
    expect(wiki.children.map((c) => c.name)).toEqual(['Apple', 'banana'])
  })
})
