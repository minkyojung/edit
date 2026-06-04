import { describe, expect, it } from 'vitest'
import { parseVizSpec } from './vizSpec'

describe('parseVizSpec', () => {
  it('lifts a legacy ChartSpec (kind, no type) into a chart leaf', () => {
    const node = parseVizSpec(
      JSON.stringify({ kind: 'donut', title: 'Allocation', data: [{ label: 'A', value: 45 }] }),
    )
    expect(node).toEqual({
      type: 'donut',
      title: 'Allocation',
      data: [{ label: 'A', value: 45 }],
    })
  })

  it('parses a type-keyed chart leaf', () => {
    const node = parseVizSpec(
      JSON.stringify({ type: 'bar', data: [{ label: 'X', value: 1 }] }),
    )
    expect(node?.type).toBe('bar')
  })

  it('parses a composite tree (stack of columns + leaves)', () => {
    const node = parseVizSpec(
      JSON.stringify({
        type: 'stack',
        gap: 'lg',
        children: [
          { type: 'text', value: 'Dashboard', variant: 'title' },
          {
            type: 'columns',
            children: [
              { type: 'stat', label: 'Revenue', value: '$1.2M', sub: 'YTD' },
              { type: 'donut', data: [{ label: 'A', value: 30 }] },
            ],
          },
        ],
      }),
    )
    expect(node?.type).toBe('stack')
    expect(node).toMatchObject({ gap: 'lg' })
    if (node?.type === 'stack') {
      expect(node.children).toHaveLength(2)
      expect(node.children[0]).toEqual({ type: 'text', value: 'Dashboard', variant: 'title' })
      expect(node.children[1].type).toBe('columns')
    }
  })

  it('parses stat / text / table leaves', () => {
    expect(parseVizSpec(JSON.stringify({ type: 'stat', label: 'Users', value: '1,024' }))).toEqual({
      type: 'stat',
      label: 'Users',
      value: '1,024',
      sub: undefined,
    })
    expect(parseVizSpec(JSON.stringify({ type: 'text', value: 'hi' }))).toEqual({
      type: 'text',
      value: 'hi',
      variant: undefined,
    })
    expect(
      parseVizSpec(
        JSON.stringify({ type: 'table', columns: ['a', 'b'], rows: [['x', 1], ['y', 2]] }),
      ),
    ).toEqual({ type: 'table', columns: ['a', 'b'], rows: [['x', 1], ['y', 2]] })
  })

  it('drops an unknown gap to undefined (renderer defaults md)', () => {
    const node = parseVizSpec(
      JSON.stringify({ type: 'stack', gap: 'huge', children: [{ type: 'text', value: 'x' }] }),
    )
    expect(node).toMatchObject({ type: 'stack', gap: undefined })
  })

  it('returns null on an unknown node type', () => {
    expect(parseVizSpec(JSON.stringify({ type: 'carousel' }))).toBeNull()
  })

  it('returns null when any child is invalid (whole tree falls back to source)', () => {
    expect(
      parseVizSpec(
        JSON.stringify({
          type: 'stack',
          children: [{ type: 'text', value: 'ok' }, { type: 'bogus' }],
        }),
      ),
    ).toBeNull()
  })

  it('returns null on an empty layout (no children)', () => {
    expect(parseVizSpec(JSON.stringify({ type: 'stack', children: [] }))).toBeNull()
  })

  it('returns null when nesting exceeds the depth limit', () => {
    // Build stack > stack > ... deeper than MAX_DEPTH (6).
    let json: Record<string, unknown> = { type: 'text', value: 'leaf' }
    for (let i = 0; i < 8; i++) json = { type: 'stack', children: [json] }
    expect(parseVizSpec(JSON.stringify(json))).toBeNull()
  })

  it('returns null when node count exceeds the limit', () => {
    const children = Array.from({ length: 200 }, () => ({ type: 'text', value: 'x' }))
    expect(parseVizSpec(JSON.stringify({ type: 'stack', children }))).toBeNull()
  })

  it('returns null on a malformed table row', () => {
    expect(
      parseVizSpec(JSON.stringify({ type: 'table', columns: ['a'], rows: [[{}]] })),
    ).toBeNull()
  })

  it('returns null on invalid JSON (half-streamed fence)', () => {
    expect(parseVizSpec('{ "type": "stack", "children": [')).toBeNull()
  })

  it('returns null when a chart leaf has invalid data', () => {
    expect(parseVizSpec(JSON.stringify({ type: 'donut', data: [] }))).toBeNull()
  })
})
