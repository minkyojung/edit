import { describe, expect, it } from 'vitest'
import {
  dateKeyOf,
  groupByDate,
  renderTimeline,
  UNDATED,
  type TimelineRow,
} from './vaultTimeline'

describe('dateKeyOf', () => {
  it('uses a daily note’s own date verbatim', () => {
    expect(dateKeyOf({ type: 'daily', date: '2026-07-13' })).toBe('2026-07-13')
  })

  it('slices createdAt to its leading YYYY-MM-DD', () => {
    expect(
      dateKeyOf({ type: 'note', createdAt: '2026-07-13T22:41:09.000Z' }),
    ).toBe('2026-07-13')
  })

  it('prefers a daily date over createdAt', () => {
    expect(
      dateKeyOf({ type: 'daily', date: '2026-07-13', createdAt: '2026-01-01T00:00:00Z' }),
    ).toBe('2026-07-13')
  })

  it('falls back to Undated when neither is present or well-formed', () => {
    expect(dateKeyOf({ type: 'note' })).toBe(UNDATED)
    expect(dateKeyOf({ type: 'note', createdAt: 'garbage' })).toBe(UNDATED)
    expect(dateKeyOf({ type: 'daily', date: 'nope' })).toBe(UNDATED)
  })
})

describe('groupByDate', () => {
  function row(
    dateKey: string,
    createdAt: string,
    path: string,
    title = path,
  ): TimelineRow {
    return { dateKey, createdAt, path, title }
  }

  it('orders days newest-first with Undated always last', () => {
    const days = groupByDate([
      row(UNDATED, '', 'old/legacy.md'),
      row('2026-07-11', '2026-07-11T09:00:00Z', 'a.md'),
      row('2026-07-13', '2026-07-13T09:00:00Z', 'b.md'),
      row('2026-07-12', '2026-07-12T09:00:00Z', 'c.md'),
    ])
    expect(days.map((d) => d.date)).toEqual([
      '2026-07-13',
      '2026-07-12',
      '2026-07-11',
      UNDATED,
    ])
  })

  it('orders notes within a day newest createdAt first', () => {
    const days = groupByDate([
      row('2026-07-13', '2026-07-13T08:00:00Z', 'morning.md'),
      row('2026-07-13', '2026-07-13T20:00:00Z', 'evening.md'),
    ])
    expect(days[0].entries.map((e) => e.path)).toEqual([
      'evening.md',
      'morning.md',
    ])
  })

  it('breaks ties on title so output is stable', () => {
    const days = groupByDate([
      row('2026-07-13', '2026-07-13T08:00:00Z', 'b.md', 'Beta'),
      row('2026-07-13', '2026-07-13T08:00:00Z', 'a.md', 'Alpha'),
    ])
    expect(days[0].entries.map((e) => e.title)).toEqual(['Alpha', 'Beta'])
  })
})

describe('renderTimeline', () => {
  it('renders a day heading over a bullet per note', () => {
    const out = renderTimeline([
      {
        date: '2026-07-13',
        entries: [{ path: 'wiki/Sarah.md', title: 'Sarah' }],
      },
    ])
    expect(out).toContain('## 2026-07-13')
    expect(out).toContain('- `wiki/Sarah.md` — Sarah')
  })

  it('escapes pipes so a title cannot break rendering', () => {
    const out = renderTimeline([
      { date: '2026-07-13', entries: [{ path: 'a.md', title: 'A | B' }] },
    ])
    expect(out).toContain('A \\| B')
  })

  it('returns a placeholder for an empty vault', () => {
    expect(renderTimeline([])).toBe('_No notes yet._')
  })
})
