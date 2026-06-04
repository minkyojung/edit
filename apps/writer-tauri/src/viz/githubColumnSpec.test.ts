import { describe, expect, it } from 'vitest'
import type { Entry } from '@/lib/eventsDb'
import { entriesToDailyColumnSpec, isMergeCommit } from './githubColumnSpec'

// Minimal Entry; `ts` without a timezone parses as LOCAL time, so getHours()
// is deterministic across machines.
function entry(kind: string, hour: number, summary = ''): Entry {
  const hh = String(hour).padStart(2, '0')
  return {
    id: `${kind}-${hour}-${summary}`,
    ts: `2026-06-04T${hh}:30:00`,
    ingestedAt: `2026-06-04T${hh}:31:00`,
    source: 'github',
    kind,
    summary,
    entities: [],
    refs: [],
    payload: null,
  }
}

describe('entriesToDailyColumnSpec', () => {
  it('buckets counts by hour and kind into a 24-slot stacked column spec', () => {
    const spec = entriesToDailyColumnSpec([
      entry('commit', 8, 'fix x'),
      entry('commit', 8, 'fix y'),
      entry('pr_merged', 8, 'PR #1'),
      entry('commit', 20, 'late'),
    ])
    expect(spec.kind).toBe('column')
    if (spec.kind !== 'column') return
    expect(spec.xLabels).toHaveLength(24)
    expect(spec.stacked).toBe(true)
    const commit = spec.series.find((s) => s.label === 'commit')
    expect(commit?.values[8]).toBe(2)
    expect(commit?.values[20]).toBe(1)
    expect(spec.series.find((s) => s.label === 'PR merged')?.values[8]).toBe(1)
  })

  it('excludes merge commits from the commit series', () => {
    const spec = entriesToDailyColumnSpec([
      entry('commit', 9, 'Merge pull request #3 from x'),
      entry('commit', 9, 'real work'),
    ])
    if (spec.kind !== 'column') throw new Error('expected column')
    expect(spec.series.find((s) => s.label === 'commit')?.values[9]).toBe(1)
  })

  it('drops all-zero kinds so the legend stays clean', () => {
    const spec = entriesToDailyColumnSpec([entry('commit', 10, 'only commits')])
    if (spec.kind !== 'column') throw new Error('expected column')
    expect(spec.series.map((s) => s.label)).toEqual(['commit'])
  })

  it('returns an empty series list when there is nothing to chart', () => {
    const spec = entriesToDailyColumnSpec([])
    if (spec.kind !== 'column') throw new Error('expected column')
    expect(spec.series).toHaveLength(0)
  })

  it('isMergeCommit matches merge summaries only', () => {
    expect(isMergeCommit('Merge pull request #1 from a/b')).toBe(true)
    expect(isMergeCommit('Merge branch main')).toBe(true)
    expect(isMergeCommit('feat: add thing')).toBe(false)
  })
})
