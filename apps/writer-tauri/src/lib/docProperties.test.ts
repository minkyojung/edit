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
import { fmEntriesFromData } from './docProperties'
import { splitFrontmatterFull } from './frontmatter'

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
