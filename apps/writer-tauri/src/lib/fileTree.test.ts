import { describe, expect, it } from 'vitest'
import {
  buildFileTree,
  filterInProgressWithAncestors,
  type TreeFolder,
} from './fileTree'
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

  it('places a youtube capture (note + inbox/ relPath) under inbox/ with its videoId', () => {
    const tree = buildFileTree([
      doc({ slug: 'y1', type: 'note', title: 'My Video', relPath: 'inbox/My Video.md', videoId: 'abc' }),
    ])
    const inbox = tree[0] as TreeFolder
    expect(inbox.name).toBe('inbox')
    expect(inbox.children[0]).toMatchObject({
      kind: 'file',
      name: 'My Video',
      slug: 'y1',
      videoId: 'abc',
    })
  })

  it('merges a daily note with its same-named folder into one folder-note', () => {
    const tree = buildFileTree([
      doc({ slug: 'd1', type: 'daily', date: '2026-06-10' }),
      doc({ slug: 'w1', type: 'writing', title: 'Note', parentId: 'd1' }),
    ])
    const daily = tree[0] as TreeFolder
    expect(daily.name).toBe('daily')
    // The date note (`daily/2026-06-10.md`) and the date folder
    // (`daily/2026-06-10/`) collapse into ONE folder-note row instead of two
    // same-named siblings.
    expect(daily.children).toHaveLength(1)
    const dateNode = daily.children[0] as TreeFolder
    expect(dateNode).toMatchObject({
      kind: 'folder',
      name: '2026-06-10',
      slug: 'd1',
      type: 'daily',
    })
    // The day's capture still nests under it.
    expect(dateNode.children[0]).toMatchObject({ kind: 'file', name: 'Note', slug: 'w1' })
  })

  it('leaves a plain folder (no same-named note) without a slug', () => {
    const tree = buildFileTree([
      doc({ slug: 'a1', type: 'note', title: 'x', relPath: 'articles/x.md' }),
    ])
    const articles = tree[0] as TreeFolder
    expect(articles.name).toBe('articles')
    expect(articles.slug).toBeUndefined()
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
      doc({ slug: 'a1', type: 'note', title: 'zebra article', relPath: 'articles/zebra article.md' }),
      doc({ slug: 'w1', type: 'wiki:custom-w1', title: 'Apple' }),
      doc({ slug: 'w2', type: 'wiki:custom-w2', title: 'banana' }),
    ])
    // top level: folders 'articles' and 'wiki' (alphabetical), no loose files
    expect(tree.map((n) => n.name)).toEqual(['articles', 'wiki'])
    const wiki = tree[1] as TreeFolder
    expect(wiki.children.map((c) => c.name)).toEqual(['Apple', 'banana'])
  })
})

describe('buildFileTree — sort modes', () => {
  // Three notes in one folder with distinct names + createdAt, so each
  // mode produces a different, unambiguous order.
  const notes = [
    doc({ slug: 'b', type: 'note', title: 'banana', relPath: 'inbox/banana.md', createdAt: '2026-02-01T00:00:00Z' }),
    doc({ slug: 'a', type: 'note', title: 'apple', relPath: 'inbox/apple.md', createdAt: '2026-03-01T00:00:00Z' }),
    doc({ slug: 'c', type: 'note', title: 'cherry', relPath: 'inbox/cherry.md', createdAt: '2026-01-01T00:00:00Z' }),
  ]
  const files = (mode: Parameters<typeof buildFileTree>[2]) =>
    (buildFileTree(notes, [], mode)[0] as TreeFolder).children.map((c) => c.name)

  it('name-asc orders A→Z (default)', () => {
    expect(files('name-asc')).toEqual(['apple', 'banana', 'cherry'])
  })

  it('name-desc orders Z→A', () => {
    expect(files('name-desc')).toEqual(['cherry', 'banana', 'apple'])
  })

  it('created-desc orders newest first', () => {
    // apple 03-01 > banana 02-01 > cherry 01-01
    expect(files('created-desc')).toEqual(['apple', 'banana', 'cherry'])
  })

  it('created-asc orders oldest first', () => {
    expect(files('created-asc')).toEqual(['cherry', 'banana', 'apple'])
  })

  it('name-desc also reverses folder order, folders still before files', () => {
    const tree = buildFileTree(
      [
        doc({ slug: 'x', type: 'note', title: 'note', relPath: 'apples/note.md' }),
        doc({ slug: 'y', type: 'note', title: 'note', relPath: 'zebras/note.md' }),
        doc({ slug: 'loose', type: 'note', title: 'loose', relPath: 'loose.md' }),
      ],
      [],
      'name-desc',
    )
    // folders zebras, apples (reversed) THEN the loose file
    expect(tree.map((n) => n.name)).toEqual(['zebras', 'apples', 'loose'])
  })

  it('created modes fall back to name when a doc lacks createdAt', () => {
    const mixed = [
      doc({ slug: 'a', type: 'note', title: 'apple', relPath: 'inbox/apple.md' }), // no createdAt
      doc({ slug: 'b', type: 'note', title: 'banana', relPath: 'inbox/banana.md', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    const names = (buildFileTree(mixed, [], 'created-desc')[0] as TreeFolder).children.map(
      (c) => c.name,
    )
    // one side has no timestamp → name compare → apple before banana
    expect(names).toEqual(['apple', 'banana'])
  })
})

describe('filterInProgressWithAncestors', () => {
  const slugs = (docs: KnownDoc[]) => docs.map((d) => d.slug).sort()

  it('keeps only in-progress notes when there are no parent chains', () => {
    const docs = [
      doc({ slug: 'a', type: 'note', relPath: 'inbox/a.md', status: 'in-progress' }),
      doc({ slug: 'b', type: 'note', relPath: 'inbox/b.md', status: 'done' }),
      doc({ slug: 'c', type: 'note', relPath: 'inbox/c.md' }), // no status
    ]
    expect(slugs(filterInProgressWithAncestors(docs))).toEqual(['a'])
  })

  it('preserves a writing note`s daily ancestor even though it is not in progress', () => {
    // The daily has no status; without keeping it, the writing note`s path
    // (which resolves through the daily) would drop out of the tree.
    const docs = [
      doc({ slug: 'd1', type: 'daily', date: '2026-06-10' }),
      doc({ slug: 'w1', type: 'writing', title: 'Note', parentId: 'd1', status: 'in-progress' }),
      doc({ slug: 'w2', type: 'writing', title: 'Other', parentId: 'd1', status: 'done' }),
    ]
    // w1 kept + its ancestor d1 kept; w2 (done) dropped.
    expect(slugs(filterInProgressWithAncestors(docs))).toEqual(['d1', 'w1'])
  })

  it('walks a multi-level parent chain up to the root', () => {
    const docs = [
      doc({ slug: 'd1', type: 'daily', date: '2026-06-10' }),
      doc({ slug: 'w1', type: 'writing', title: 'Parent', parentId: 'd1' }),
      doc({ slug: 'w2', type: 'writing', title: 'Child', parentId: 'w1', status: 'in-progress' }),
    ]
    // w2 kept → w1 (its parent) → d1 (grandparent) all kept.
    expect(slugs(filterInProgressWithAncestors(docs))).toEqual(['d1', 'w1', 'w2'])
  })

  it('returns nothing when no note is in progress', () => {
    const docs = [
      doc({ slug: 'a', type: 'note', relPath: 'inbox/a.md', status: 'done' }),
      doc({ slug: 'b', type: 'note', relPath: 'inbox/b.md' }),
    ]
    expect(filterInProgressWithAncestors(docs)).toEqual([])
  })
})

describe('buildFileTree — attachments (non-md files)', () => {
  it('places a non-md file under its folder as an attachment node (extension kept)', () => {
    const tree = buildFileTree([], [], 'name-asc', ['inbox/photo.png'])
    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'inbox',
        path: 'inbox',
        children: [{ kind: 'attachment', name: 'photo.png', path: 'inbox/photo.png' }],
      },
    ])
  })

  it('groups folders first, then notes + attachments together by name', () => {
    const tree = buildFileTree(
      [doc({ slug: 'n', type: 'note', title: 'banana', relPath: 'banana.md' })],
      ['sub'],
      'name-asc',
      ['apple.png', 'cherry.pdf'],
    )
    // folder 'sub' first, then the file group sorted by name:
    // apple.png, banana (note), cherry.pdf
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:sub',
      'attachment:apple.png',
      'file:banana',
      'attachment:cherry.pdf',
    ])
  })

  it('hides attachments under hidden tree paths', () => {
    const tree = buildFileTree([], [], 'name-asc', ['_system/secret.png', 'ok.png'])
    expect(tree.map((n) => n.name)).toEqual(['ok.png'])
  })

  it('hides legacy top-level threads/ (folder + chat JSON) from the tree', () => {
    const tree = buildFileTree(
      [],
      ['threads'],
      'name-asc',
      ['threads/abc.json', 'threads/abc.turns.jsonl', 'ok.png'],
    )
    expect(tree.map((n) => n.name)).toEqual(['ok.png'])
  })
})
