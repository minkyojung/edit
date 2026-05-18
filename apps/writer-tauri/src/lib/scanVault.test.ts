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

const noChildren = new Map<string, string>()

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
