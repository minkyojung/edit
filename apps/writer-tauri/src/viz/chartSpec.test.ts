import { describe, expect, it } from 'vitest'
import { parseChartSpec } from './chartSpec'

describe('parseChartSpec', () => {
  it('parses a valid donut spec', () => {
    const spec = parseChartSpec(
      JSON.stringify({ kind: 'donut', title: 'Allocation', data: [{ label: 'A', value: 45 }] }),
    )
    expect(spec).toEqual({
      kind: 'donut',
      title: 'Allocation',
      data: [{ label: 'A', value: 45 }],
    })
  })

  it('parses a bar spec without a title', () => {
    const spec = parseChartSpec(
      JSON.stringify({ kind: 'bar', data: [{ label: 'X', value: 1 }, { label: 'Y', value: 2 }] }),
    )
    expect(spec?.kind).toBe('bar')
    expect(spec?.title).toBeUndefined()
  })

  it('parses a kpi spec and keeps optional sub', () => {
    const spec = parseChartSpec(
      JSON.stringify({ kind: 'kpi', items: [{ label: 'Total', value: '100%', sub: 'ytd' }] }),
    )
    expect(spec).toEqual({
      kind: 'kpi',
      title: undefined,
      items: [{ label: 'Total', value: '100%', sub: 'ytd' }],
    })
  })

  it('parses a multi-series column spec', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        kind: 'column',
        xLabels: ['0h', '6h', '12h'],
        series: [
          { label: 'commit', values: [1, 2, 3] },
          { label: 'PR', values: [0, 1, 0] },
        ],
        stacked: true,
      }),
    )
    expect(spec?.kind).toBe('column')
    expect(spec).toMatchObject({ xLabels: ['0h', '6h', '12h'], stacked: true })
  })

  it('returns null when a column series has a non-numeric value', () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          kind: 'column',
          xLabels: ['a'],
          series: [{ label: 's', values: [1, 'x'] }],
        }),
      ),
    ).toBeNull()
  })

  it('returns null when a column has no xLabels', () => {
    expect(
      parseChartSpec(
        JSON.stringify({ kind: 'column', xLabels: [], series: [{ label: 's', values: [1] }] }),
      ),
    ).toBeNull()
  })

  it('returns null on invalid JSON (e.g. a half-streamed fence)', () => {
    expect(parseChartSpec('{ "kind": "donut", "data": [')).toBeNull()
  })

  it('returns null on an unknown kind', () => {
    expect(parseChartSpec(JSON.stringify({ kind: 'pie', data: [] }))).toBeNull()
  })

  it('returns null when data is empty or missing', () => {
    expect(parseChartSpec(JSON.stringify({ kind: 'bar', data: [] }))).toBeNull()
    expect(parseChartSpec(JSON.stringify({ kind: 'bar' }))).toBeNull()
  })

  it('returns null when a datum has a non-numeric value', () => {
    expect(
      parseChartSpec(JSON.stringify({ kind: 'donut', data: [{ label: 'A', value: '45' }] })),
    ).toBeNull()
  })

  it('returns null when a kpi item is missing value', () => {
    expect(parseChartSpec(JSON.stringify({ kind: 'kpi', items: [{ label: 'X' }] }))).toBeNull()
  })
})
