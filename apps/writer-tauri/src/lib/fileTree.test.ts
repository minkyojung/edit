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
})
