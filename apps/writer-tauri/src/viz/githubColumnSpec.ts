// Adapter: events.db rows → a `column` ChartSpec for the daily GitHub card.
// Pure (no React/DOM) so it's unit-testable. The card stays a "fixed frame,
// live data" view — GitHubActivityBlock re-runs this on every events bump and
// hands the result to <DataViz>, the same single engine the ```chart fence uses.

import type { Entry } from '@/lib/eventsDb'
import type { ChartSpec } from './chartSpec'

export function isMergeCommit(summary: string): boolean {
  return /^Merge (pull request|branch|remote)/i.test(summary)
}

// Series order fixes the palette mapping (commit → --viz-cat-1, etc.).
const KINDS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: 'commit', label: 'commit' },
  { kind: 'pr_opened', label: 'PR opened' },
  { kind: 'pr_merged', label: 'PR merged' },
]

/** Bucket a day's events into a 24-hour stacked column chart, counted by kind.
 * Merge commits are excluded from the commit series (matching the card's text
 * header); all-zero kinds are dropped so the legend stays clean. */
export function entriesToDailyColumnSpec(entries: Entry[], title?: string): ChartSpec {
  const counts: Record<string, number[]> = {
    commit: new Array<number>(24).fill(0),
    pr_opened: new Array<number>(24).fill(0),
    pr_merged: new Array<number>(24).fill(0),
  }
  for (const e of entries) {
    const bucket = counts[e.kind]
    if (!bucket) continue
    if (e.kind === 'commit' && isMergeCommit(e.summary)) continue
    const hour = new Date(e.ts).getHours()
    if (Number.isNaN(hour)) continue
    bucket[hour] += 1
  }
  const series = KINDS.map(({ kind, label }) => ({ label, values: counts[kind] })).filter(
    (s) => s.values.some((v) => v > 0),
  )
  const xLabels = Array.from({ length: 24 }, (_, h) => `${h}h`)
  return { kind: 'column', title, xLabels, series, stacked: true }
}
