/**
 * docProperties — the ordered full-frontmatter model behind the
 * Notion-style properties panel.
 *
 * The pinned contract: `fm` mirrors the on-disk YAML block's top-level
 * scalar / string-list keys IN FILE ORDER. Order is load-bearing — the
 * panel renders rows in `fm` order and the flush emits keys in `fm`
 * order, so file key order IS the persisted row order.
 */

import { describe, expect, it } from 'vitest'
import {
  effectiveEntries,
  fmEntriesFromData,
  isAlwaysShownKey,
  isNumericKey,
  orderedFrontmatterFields,
  typedFieldPatch,
} from './docProperties'
import { mergeFrontmatter, splitFrontmatterFull } from './frontmatter'
import { portableFrontmatterFields, type DocMetaFile } from './docPaths'

describe('isAlwaysShownKey — structural affordance rows', () => {
  it('marks status + tags structural (not renamable/deletable), others not', () => {
    // status/tags are always re-pinned by effectiveEntries, so the store
    // and panel must refuse to rename/delete them; every other key is a
    // normal, removable row.
    expect(isAlwaysShownKey('status')).toBe(true)
    expect(isAlwaysShownKey('tags')).toBe(true)
    expect(isAlwaysShownKey('created')).toBe(false)
    expect(isAlwaysShownKey('source')).toBe(false)
    expect(isAlwaysShownKey('custom')).toBe(false)
  })
})

describe('isNumericKey — order-unstable key names the app refuses', () => {
  it('flags digit-only names, accepts anything with a non-digit', () => {
    // Integer-like keys enumerate numerically in JS objects, so they can't
    // hold a stable row/file position — addDocProperty/renameDocProperty
    // reject them.
    expect(isNumericKey('1')).toBe(true)
    expect(isNumericKey('2024')).toBe(true)
    expect(isNumericKey('2024년')).toBe(false)
    expect(isNumericKey('q1')).toBe(false)
    expect(isNumericKey('priority')).toBe(false)
    expect(isNumericKey('')).toBe(false)
  })
})

describe('fmEntriesFromData', () => {
  it('preserves file key order through the parser', () => {
    const { data } = splitFrontmatterFull(
      '---\nzeta: 1\ncreated: 2026-01-01\nalpha: two\ntags:\n  - a\n  - b\n---\n\nbody\n',
    )
    expect(fmEntriesFromData(data)).toEqual([
      { key: 'zeta', value: '1' },
      { key: 'created', value: '2026-01-01' },
      { key: 'alpha', value: 'two' },
      { key: 'tags', value: ['a', 'b'] },
    ])
  })

  it('includes foreign scalar keys the typed projection would drop', () => {
    const { data } = splitFrontmatterFull(
      '---\nmy custom key: hello\ncreated: 2026-01-01\n---\n\nbody\n',
    )
    expect(fmEntriesFromData(data)?.map((e) => e.key)).toEqual([
      'my custom key',
      'created',
    ])
  })

  it('omits nested maps (foreign on write, invisible in the panel)', () => {
    const { data } = splitFrontmatterFull(
      '---\nplain: yes\nnested:\n  a: 1\n  b: 2\n---\n\nbody\n',
    )
    // splitFrontmatterFull skips non-scalar values; fm mirrors that.
    expect(fmEntriesFromData(data)).toEqual([{ key: 'plain', value: 'yes' }])
  })

  it('returns undefined for an empty block (no phantom empty arrays)', () => {
    expect(fmEntriesFromData({})).toBeUndefined()
  })
})

describe('effectiveEntries — the shared panel/flush union', () => {
  it('keeps fm order, re-injects typed values, leads with the tags affordance', () => {
    const fm = [
      { key: 'custom', value: 'x' },
      { key: 'status', value: 'stale-copy' },
      { key: 'created', value: '2026-01-01' },
    ]
    const meta: Partial<DocMetaFile> = { status: 'done', createdAt: '2026-01-01' }
    // status is placed by fm (stays there); tags isn't, so its always-shown
    // affordance leads at the top as an empty placeholder.
    expect(effectiveEntries(fm, meta)).toEqual([
      { key: 'tags', value: [] },
      { key: 'custom', value: 'x' },
      { key: 'status', value: 'done' }, // meta wins over the fm mirror
      { key: 'created', value: '2026-01-01' },
    ])
  })

  it('aliases legacy keys in place (createdAt keeps its row position)', () => {
    const fm = [
      { key: 'custom', value: 'x' },
      { key: 'createdAt', value: '2026-01-01' },
    ]
    const entries = effectiveEntries(fm, { createdAt: '2026-01-01' })
    // Leading affordances first, then fm order with createdAt aliased.
    expect(entries.map((e) => e.key)).toEqual(['status', 'tags', 'custom', 'created'])
  })

  it('hides slug, de-dupes aliased keys first-wins', () => {
    const fm = [
      { key: 'slug', value: 'abc' },
      { key: 'created', value: '2026-02-02' },
      { key: 'createdAt', value: '2026-01-01' }, // aliases to created → dup
    ]
    const entries = effectiveEntries(fm, { createdAt: '2026-02-02' })
    expect(entries).toEqual([
      { key: 'status', value: '' },
      { key: 'tags', value: [] },
      { key: 'created', value: '2026-02-02' },
    ])
  })

  it('leads with status + tags, then appends other typed keys canonically', () => {
    const meta: Partial<DocMetaFile> = {
      status: 'in-progress',
      tags: ['a'],
      createdAt: '2026-01-01',
    }
    // status/tags pin to the top (their affordance slot); created follows.
    expect(effectiveEntries(undefined, meta).map((e) => e.key)).toEqual([
      'status',
      'tags',
      'created',
    ])
  })

  it('always shows status + tags even on a bare note (empty placeholders)', () => {
    expect(effectiveEntries(undefined, {})).toEqual([
      { key: 'status', value: '' },
      { key: 'tags', value: [] },
    ])
  })

  it('does not re-pin status to the top once the file has placed it', () => {
    // status in fm renders at its fm position; only tags (absent) leads.
    const fm = [
      { key: 'custom', value: 'x' },
      { key: 'status', value: 'done' },
    ]
    expect(effectiveEntries(fm, { status: 'done' }).map((e) => e.key)).toEqual([
      'tags',
      'custom',
      'status',
    ])
  })
})

describe('orderedFrontmatterFields — reorder/delete through the flush', () => {
  it('round-trips panel order into file key order via mergeFrontmatter', () => {
    const existing =
      '---\ncreated: 2026-01-01\ncustom: x\nstatus: done\n---\n\nbody\n'
    const { data } = splitFrontmatterFull(existing)
    // Simulate a panel reorder: custom first, then status, then created.
    const fm = [
      { key: 'custom', value: 'x' },
      { key: 'status', value: 'done' },
      { key: 'created', value: '2026-01-01' },
    ]
    const meta: Partial<DocMetaFile> = { status: 'done', createdAt: '2026-01-01' }
    const merged = mergeFrontmatter(
      existing,
      orderedFrontmatterFields(fm, meta, data),
      'body\n',
    )
    expect(Object.keys(splitFrontmatterFull(merged).data)).toEqual([
      'custom',
      'status',
      'created',
    ])
  })

  it('makes a panel DELETE stick by claiming the on-disk key', () => {
    const existing = '---\ncreated: 2026-01-01\ndoomed: bye\n---\n\nbody\n'
    const { data } = splitFrontmatterFull(existing)
    // Panel deleted `doomed`: it's absent from fm; the claim from
    // existingData drops its line instead of preserving it.
    const fm = [{ key: 'created', value: '2026-01-01' }]
    const merged = mergeFrontmatter(
      existing,
      orderedFrontmatterFields(fm, { createdAt: '2026-01-01' }, data),
      'body\n',
    )
    expect(splitFrontmatterFull(merged).data).toEqual({ created: '2026-01-01' })
  })

  it('drops legacy slug/createdAt/sourceUrl lines (lazy migration)', () => {
    const existing =
      '---\nslug: abc123\ncreatedAt: 2026-01-01\ncustom: x\n---\n\nbody\n'
    const { data } = splitFrontmatterFull(existing)
    const fm = fmEntriesFromData(data)
    const merged = mergeFrontmatter(
      existing,
      orderedFrontmatterFields(fm, { createdAt: '2026-01-01' }, data),
      'body\n',
    )
    const out = splitFrontmatterFull(merged).data
    expect(out).toEqual({ created: '2026-01-01', custom: 'x' })
    // Aliased in place: created sits where createdAt was (after nothing —
    // slug was dropped), before custom? createdAt preceded custom, so:
    expect(Object.keys(out)).toEqual(['created', 'custom'])
  })

  it('preserves a nested map verbatim (never claimed, pinned by merge)', () => {
    const existing =
      '---\nnested:\n  a: 1\ncreated: 2026-01-01\n---\n\nbody\n'
    const { data } = splitFrontmatterFull(existing) // nested skipped here
    const fm = fmEntriesFromData(data)
    const merged = mergeFrontmatter(
      existing,
      orderedFrontmatterFields(fm, { createdAt: '2026-01-01' }, data),
      'body\n',
    )
    expect(merged).toContain('nested:\n  a: 1')
  })

  it('serializes canonical-order docs byte-identically to the legacy branch', () => {
    // A doc that has never been panel-reordered (fm in canonical order)
    // must produce the same bytes through either flush branch, so
    // toggling propertyDirty introduces zero churn.
    const meta: Partial<DocMetaFile> = {
      createdAt: '2026-01-01',
      sourceUrl: 'https://x.test',
      status: 'done',
      tags: ['a', 'b'],
    }
    const existing = mergeFrontmatter('', portableFrontmatterFields(meta), 'body\n')
    const { data } = splitFrontmatterFull(existing)
    const fm = fmEntriesFromData(data)
    const viaOrdered = mergeFrontmatter(
      existing,
      orderedFrontmatterFields(fm, meta, data),
      'body\n',
    )
    expect(viaOrdered).toBe(existing)
  })
})

describe('typedFieldPatch — generic edits of typed keys', () => {
  it('validates status against the known set', () => {
    expect(typedFieldPatch('status', 'done')).toEqual({ status: 'done' })
    expect(typedFieldPatch('status', 'garbage')).toBeNull()
    expect(typedFieldPatch('status', '')).toEqual({ status: undefined })
  })

  it('normalizes tags and clears on empty', () => {
    expect(typedFieldPatch('tags', [' a ', 'a', 'b'])).toEqual({ tags: ['a', 'b'] })
    expect(typedFieldPatch('tags', [])).toEqual({ tags: undefined })
  })

  it('parses durationSec and rejects non-numbers', () => {
    expect(typedFieldPatch('durationSec', '72')).toEqual({ durationSec: 72 })
    expect(typedFieldPatch('durationSec', 'oops')).toBeNull()
  })

  it('trims plain string fields, empty clears', () => {
    expect(typedFieldPatch('created', ' 2026-01-01 ')).toEqual({
      createdAt: '2026-01-01',
    })
    expect(typedFieldPatch('source', '')).toEqual({ sourceUrl: undefined })
  })
})
