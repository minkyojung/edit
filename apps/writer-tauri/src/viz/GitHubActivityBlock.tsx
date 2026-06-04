// GitHub daily-activity block — a viz renderer sibling of Mermaid/Artifact,
// rendered by CodeBlockVizNodeView for ```github-activity fences. Unlike
// those (static source), this reads LIVE data: the fence carries only a
// date; this component queries events.db for that day and re-queries when
// the events store bumps (after a sync), so the chart follows the data.
//
// The chart shape is the fixed githubDailySpec; only the data changes —
// the "fixed frame, live data" model.

import { useEffect, useState } from 'react'
import { eventsQueryByDate, type Entry } from '@/lib/eventsDb'
import { useEventsStore } from '@/state/eventsStore'
import { DataViz } from './DataViz'
import { entriesToDailyColumnSpec, isMergeCommit } from './githubColumnSpec'

export function GitHubActivityBlock({ date }: { date: string }) {
  // version bumps after every sync → re-query for live updates.
  const version = useEventsStore((s) => s.version)
  const [entries, setEntries] = useState<Entry[]>([])

  useEffect(() => {
    let cancelled = false
    eventsQueryByDate(date)
      .then((e) => {
        if (!cancelled) setEntries(e)
      })
      .catch((err) => {
        console.warn('[github-activity] query failed', err)
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [date, version])

  const commits = entries.filter(
    (e) => e.kind === 'commit' && !isMergeCommit(e.summary),
  )
  const merged = entries.filter((e) => e.kind === 'pr_merged')
  const opened = entries.filter((e) => e.kind === 'pr_opened')

  const parts: string[] = []
  if (commits.length)
    parts.push(`${commits.length} commit${commits.length > 1 ? 's' : ''}`)
  if (merged.length) parts.push(`${merged.length} PR merged`)
  if (opened.length) parts.push(`${opened.length} PR opened`)

  // Bucket the day's events into the shared engine's column spec (the same
  // <DataViz> the ```chart fence uses). Live updates ride the events store
  // subscription above, not the renderer.
  const spec = entriesToDailyColumnSpec(entries)
  const hasChart = spec.kind === 'column' && spec.series.length > 0

  return (
    <div className="github-activity-card-body rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-foreground">GitHub</span>
        <span className="text-muted-foreground/50">{date}</span>
        <span className="text-muted-foreground">
          {parts.length ? parts.join(' · ') : 'No activity'}
        </span>
      </div>
      {hasChart && (
        <div className="mt-2">
          <DataViz spec={spec} />
        </div>
      )}
    </div>
  )
}
