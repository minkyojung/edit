import { describe, expect, it } from 'vitest'
import { panelRows } from './propertyRows'

const keys = (rows: ReturnType<typeof panelRows>) => rows.map((r) => r.key)

describe('panelRows', () => {
  it('always shows status + tags affordance rows, even on a bare note', () => {
    const rows = panelRows({})
    expect(keys(rows)).toEqual(['status', 'tags'])
    expect(rows[0]).toMatchObject({ editor: 'status', typed: true })
    expect(rows[1]).toMatchObject({ editor: 'tags', typed: true })
  })

  it('adds created when the note has a creation date', () => {
    expect(keys(panelRows({ createdAt: '2026-06-11T00:00:00.000Z' }))).toEqual([
      'status',
      'tags',
      'created',
    ])
  })

  it('adds source + readAt for a captured note (has sourceUrl)', () => {
    expect(
      keys(
        panelRows({
          createdAt: '2026-06-11T00:00:00.000Z',
          sourceUrl: 'https://example.com/a',
        }),
      ),
    ).toEqual(['status', 'tags', 'created', 'source', 'readAt'])
  })

  it('shows source + readAt without created when only sourceUrl is present', () => {
    expect(keys(panelRows({ sourceUrl: 'https://example.com/a' }))).toEqual([
      'status',
      'tags',
      'source',
      'readAt',
    ])
  })

  it('renders rows in fm (file) order, custom keys included, slug hidden', () => {
    const rows = panelRows({
      fm: [
        { key: 'slug', value: 'x' },
        { key: 'custom', value: 'hello' },
        { key: 'created', value: '2026-01-01' },
        { key: 'status', value: 'done' },
      ],
      status: 'done',
      createdAt: '2026-01-01',
    })
    // fm order preserved; status was placed by the file so it is NOT
    // prepended; tags (absent) still prepends as the affordance row.
    expect(keys(rows)).toEqual(['tags', 'custom', 'created', 'status'])
    expect(rows.find((r) => r.key === 'custom')).toMatchObject({
      editor: 'text',
      typed: false,
    })
  })

  it('picks the value editor by shape for custom keys (fixed rule, no AI)', () => {
    const rows = panelRows({
      fm: [
        { key: 'checklist', value: ['a', 'b'] },
        { key: 'published', value: 'true' },
        { key: 'note', value: 'plain' },
      ],
    })
    expect(rows.find((r) => r.key === 'checklist')?.editor).toBe('list')
    expect(rows.find((r) => r.key === 'published')?.editor).toBe('switch')
    expect(rows.find((r) => r.key === 'note')?.editor).toBe('text')
  })
})
