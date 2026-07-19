/**
 * scanVault — disk-layout placement rules.
 *
 * These tests pin the contract between the four vault subdirectories
 * (`wiki/`, `daily/`, `_system/`, plus daily writing notes) and the
 * KnownDoc shape they produce. A regression here means external
 * tools (vim creating a file under a "wrong" path) or future layout
 * changes silently break the in-memory catalog.
 *
 * Scope is the pure `mdRelToKnownDoc` helper — the I/O orchestration
 * around it (recursive readDir, slug sidecar read/write) is exercised
 * end-to-end at app boot, not unit-tested here. Mocking Tauri fs
 * extensively would couple the tests to the I/O layer rather than the
 * placement contract.
 */

import { describe, expect, it } from 'vitest'
import { mdRelToKnownDoc } from './scanVault'
import {
  frontmatterToMeta,
  metaToFrontmatterFields,
  portableFrontmatterFields,
  type DocMetaFile,
} from './docPaths'
import { composeFrontmatter, splitFrontmatter } from './frontmatter'

const noChildren = new Map<string, string>()

describe('portableFrontmatterFields — what stays in the user .md', () => {
  it('excludes the app-private slug', () => {
    const fields = portableFrontmatterFields({
      version: 1,
      slug: 'abc12345',
      createdAt: '2026-01-01',
      sourceUrl: 'https://x.test',
    })
    // Present: portable. Absent: app-private (slug).
    expect(fields.createdAt).toBe('2026-01-01')
    expect(fields.sourceUrl).toBe('https://x.test')
    expect('slug' in fields).toBe(false)
  })
})

describe('mdRelToKnownDoc — wiki', () => {
  it('maps wiki/<title>.md to a wiki:custom-<slug> entry', () => {
    const result = mdRelToKnownDoc('slug-abc', 'wiki/Tom.md', noChildren)
    expect(result).toEqual({
      slug: 'slug-abc',
      type: 'wiki:custom-slug-abc',
      title: 'Tom',
    })
  })

  it('preserves the title verbatim (whitespace, punctuation)', () => {
    // The title is what becomes the on-disk filename via sanitizeFilename
    // on the write side — the read side just echoes whatever's there.
    const result = mdRelToKnownDoc('s1', 'wiki/Tom (the boss).md', noChildren)
    expect(result?.title).toBe('Tom (the boss)')
  })

  it('rejects wiki pages nested deeper than one level', () => {
    // Karpathy wiki keeps the wiki/ folder flat (1-deep). A nested
    // path is treated as unknown and skipped rather than misclassified.
    expect(mdRelToKnownDoc('s1', 'wiki/people/Tom.md', noChildren)).toBeNull()
  })
})

describe('mdRelToKnownDoc — daily', () => {
  it('maps daily/<YYYY-MM-DD>.md to a daily entry with the parsed date', () => {
    const result = mdRelToKnownDoc('slug-d1', 'daily/2026-05-18.md', noChildren)
    expect(result).toEqual({
      slug: 'slug-d1',
      type: 'daily',
      date: '2026-05-18',
    })
  })

  it('rejects a daily with a non-conforming date format', () => {
    // The strict regex gate is what stops stray `daily/random.md` files
    // (created by vim, git, or a user typo) from posing as dailies and
    // polluting the date axis.
    expect(mdRelToKnownDoc('s1', 'daily/random.md', noChildren)).toBeNull()
    expect(mdRelToKnownDoc('s1', 'daily/2026-5-18.md', noChildren)).toBeNull()
    expect(mdRelToKnownDoc('s1', 'daily/2026-05-1.md', noChildren)).toBeNull()
  })
})

describe('mdRelToKnownDoc — writing under a daily', () => {
  const dailyMap = new Map([['2026-05-18', 'daily-slug-xyz']])

  it('maps daily/<date>/<title>.md to a writing with parentId resolved', () => {
    const result = mdRelToKnownDoc(
      'writing-slug',
      'daily/2026-05-18/My note.md',
      dailyMap,
    )
    expect(result).toEqual({
      slug: 'writing-slug',
      type: 'writing',
      title: 'My note',
      parentId: 'daily-slug-xyz',
    })
  })

  it('returns null when the parent daily is absent from the map', () => {
    // Orphan writing — would normally only happen if the daily got
    // deleted externally. We refuse to fabricate a phantom parent.
    const orphanMap = new Map<string, string>()
    expect(
      mdRelToKnownDoc('w1', 'daily/2026-05-18/Note.md', orphanMap),
    ).toBeNull()
  })
})

describe('mdRelToKnownDoc — system pages', () => {
  it('maps _system/<name>.md to system:<name>', () => {
    const result = mdRelToKnownDoc(
      'sys-slug',
      '_system/conventions.md',
      noChildren,
    )
    expect(result).toEqual({
      slug: 'sys-slug',
      type: 'system:conventions',
    })
  })

  it('rejects nested system files (single-level convention)', () => {
    expect(
      mdRelToKnownDoc('s1', '_system/sub/log.md', noChildren),
    ).toBeNull()
  })
})

describe('mdRelToKnownDoc — inbox (captures)', () => {
  it('maps inbox/<title>.md to a generic note carrying its path', () => {
    expect(mdRelToKnownDoc('yt-1', 'inbox/Tim Urban TED.md', noChildren)).toEqual({
      slug: 'yt-1',
      type: 'note',
      title: 'Tim Urban TED',
      relPath: 'inbox/Tim Urban TED.md',
    })
  })

  it('layers youtube frontmatter metadata onto the path-derived note', () => {
    const md = [
      '---',
      'slug: yt-2',
      'sourceUrl: https://www.youtube.com/watch?v=arj7oStGLkU',
      'siteName: TED',
      'videoId: arj7oStGLkU',
      'durationSec: 843',
      'thumbnailUrl: https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg',
      '---',
      '',
      '[00:12] So in college...',
    ].join('\n')
    const { data } = splitFrontmatter(md)
    const doc = mdRelToKnownDoc('yt-2', 'inbox/Master Procrastinator.md', noChildren, frontmatterToMeta(data))
    expect(doc).toEqual({
      slug: 'yt-2',
      type: 'note',
      title: 'Master Procrastinator',
      relPath: 'inbox/Master Procrastinator.md',
      sourceUrl: 'https://www.youtube.com/watch?v=arj7oStGLkU',
      siteName: 'TED',
      videoId: 'arj7oStGLkU',
      durationSec: 843,
      thumbnailUrl: 'https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg',
    })
  })
})

describe('mdRelToKnownDoc — generic notes (folder-tree mode)', () => {
  it('maps any other .md to a note carrying its path, when allowed', () => {
    expect(mdRelToKnownDoc('n1', 'projects/Memo.md', noChildren, {}, true)).toEqual({
      slug: 'n1',
      type: 'note',
      title: 'Memo',
      relPath: 'projects/Memo.md',
    })
  })

  it('handles a root-level note', () => {
    expect(mdRelToKnownDoc('n2', 'README.md', noChildren, {}, true)).toMatchObject({
      type: 'note',
      title: 'README',
      relPath: 'README.md',
    })
  })

  it('still skips unrecognised paths when allowGeneric is off (default)', () => {
    expect(mdRelToKnownDoc('n3', 'projects/Memo.md', noChildren)).toBeNull()
  })

  it('prefers a recognised type over generic, even when allowed', () => {
    expect(mdRelToKnownDoc('w1', 'wiki/Tom.md', noChildren, {}, true)).toMatchObject({
      type: 'wiki:custom-w1',
      title: 'Tom',
    })
  })
})

describe('mdRelToKnownDoc — unknown paths', () => {
  it('returns null for paths outside the four recognised subdirectories', () => {
    expect(mdRelToKnownDoc('s1', 'random.md', noChildren)).toBeNull()
    expect(mdRelToKnownDoc('s1', 'threads/x.md', noChildren)).toBeNull()
    expect(mdRelToKnownDoc('s1', 'archive/old.md', noChildren)).toBeNull()
  })

  it('returns null for files outside the .md extension', () => {
    // The recursive walk already filters non-.md files, but the
    // placement rule itself also gates on the extension — defence
    // in depth so a direct caller can't pass a sidecar by mistake.
    expect(mdRelToKnownDoc('s1', 'wiki/Tom.meta.json', noChildren)).toBeNull()
    expect(mdRelToKnownDoc('s1', 'wiki/Tom.ydoc', noChildren)).toBeNull()
  })
})

// ── Frontmatter read path ────────────────────────────────────────────
// The file-first metadata home: when a doc's metadata lives in its own
// `---` block instead of a `.meta.json` sidecar, frontmatterToMeta maps
// it back to the same sidecar shape the catalog overlay reads.

describe('frontmatterToMeta', () => {
  it('passes through string identity + soft-state fields', () => {
    expect(
      frontmatterToMeta({
        slug: 'abc123',
        createdAt: '2026-06-11T00:00:00.000Z',
      }),
    ).toEqual({
      slug: 'abc123',
      createdAt: '2026-06-11T00:00:00.000Z',
    })
  })

  it('coerces numeric fields from their string form', () => {
    expect(frontmatterToMeta({ durationSec: '72' })).toEqual({
      durationSec: 72,
    })
  })

  it('drops a non-numeric numeric field rather than storing NaN', () => {
    expect(frontmatterToMeta({ slug: 'x', durationSec: 'oops' })).toEqual({ slug: 'x' })
  })

  it('restores article source metadata', () => {
    expect(
      frontmatterToMeta({
        slug: 'a1',
        sourceUrl: 'https://x.com/p',
        siteName: 'X',
        savedAt: '2026-06-10',
      }),
    ).toEqual({
      slug: 'a1',
      sourceUrl: 'https://x.com/p',
      siteName: 'X',
      savedAt: '2026-06-10',
    })
  })

  it('ignores unrecognised keys', () => {
    expect(frontmatterToMeta({ slug: 'x', somethingNew: 'ignored' })).toEqual({ slug: 'x' })
  })
})

describe('frontmatter → KnownDoc (read path logic)', () => {
  it('rebuilds a saved article from its frontmatter block', () => {
    const md = [
      '---',
      'slug: art-1',
      'sourceUrl: https://example.com/post',
      'siteName: Example',
      '---',
      '',
      'Article body here.',
    ].join('\n')

    const { data } = splitFrontmatter(md)
    const doc = mdRelToKnownDoc('art-1', 'articles/My Saved Post.md', noChildren, frontmatterToMeta(data))

    expect(doc).toEqual({
      slug: 'art-1',
      type: 'note',
      title: 'My Saved Post',
      relPath: 'articles/My Saved Post.md',
      sourceUrl: 'https://example.com/post',
      siteName: 'Example',
    })
  })

  it('takes the title from the filename verbatim (Obsidian-style)', () => {
    const { data } = splitFrontmatter('---\nslug: w1\n---\n\nbody')
    const daily = new Map([['2026-06-08', 'daily-1']])
    const doc = mdRelToKnownDoc('w1', 'daily/2026-06-08/Untitled.md', daily, frontmatterToMeta(data))

    expect(doc?.title).toBe('Untitled') // shown literally, no placeholder flag
    expect(doc?.type).toBe('writing')
    expect(doc?.parentId).toBe('daily-1')
  })
})

// The read and write mappings are inverses. This round-trip is the guard
// that keeps them in lockstep: write a doc's metadata to frontmatter, read
// it back, and it must reconstruct the same fields. A field added to one
// mapping but not the other fails here rather than silently losing data on
// the first save of a frontmatter-native doc.
describe('meta ⇄ frontmatter round-trip', () => {
  it('reconstructs every emitted field through compose → split', () => {
    const meta: Partial<DocMetaFile> = {
      slug: 'note-9',
      createdAt: '2026-06-11T00:00:00.000Z',
      sourceUrl: 'https://example.com/watch?v=abc',
      siteName: 'Example',
      savedAt: '2026-06-10T09:00:00.000Z',
      readAt: '2026-06-10T10:00:00.000Z',
      status: 'in-progress',
    }

    const fields = metaToFrontmatterFields(meta)
    const file = composeFrontmatter(fields, 'The note body.\n')
    const { data, body } = splitFrontmatter(file)

    expect(frontmatterToMeta(data)).toEqual(meta)
    expect(body).toBe('The note body.\n')
  })

  it('drops an unknown status value on read', () => {
    // status is user- and AI-writable, so a value outside the known set is
    // rejected rather than trusted into the catalog.
    expect(frontmatterToMeta({ status: 'garbage' }).status).toBeUndefined()
    expect(frontmatterToMeta({ status: 'done' }).status).toBe('done')
  })

  it('round-trips youtube capture fields (durationSec stays numeric)', () => {
    const meta: Partial<DocMetaFile> = {
      slug: 'yt-3',
      sourceUrl: 'https://www.youtube.com/watch?v=arj7oStGLkU',
      siteName: 'TED',
      videoId: 'arj7oStGLkU',
      durationSec: 843,
      thumbnailUrl: 'https://i.ytimg.com/vi/arj7oStGLkU/hq.jpg',
    }
    const { data } = splitFrontmatter(composeFrontmatter(metaToFrontmatterFields(meta), 'transcript'))
    expect(frontmatterToMeta(data)).toEqual(meta)
  })

  it('drops version (sidecar-only bookkeeping)', () => {
    const fields = metaToFrontmatterFields({ version: 1, slug: 'x' })
    expect(fields.slug).toBe('x')
    expect('version' in fields).toBe(false)
  })
})
