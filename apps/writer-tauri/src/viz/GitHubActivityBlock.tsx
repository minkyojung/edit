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
import { VegaBlock } from './VegaBlock'
import { githubDailySpec } from './specs/githubDailySpec'

function isMergeCommit(summary: string): boolean {
  return /^Merge (pull request|branch|remote)/i.test(summary)
}

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

  // One row per event, bucketed by local hour; Vega aggregates the count.
  const rows = entries
    .map((e) => ({ hour: new Date(e.ts).getHours(), kind: e.kind }))
    .filter((r) => !Number.isNaN(r.hour))

  return (
    <div className="github-activity-card-body rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-foreground">GitHub</span>
        <span className="text-muted-foreground/50">{date}</span>
        <span className="text-muted-foreground">
          {parts.length ? parts.join(' · ') : 'No activity'}
        </span>
      </div>
      {entries.length > 0 && (
        <VegaBlock spec={githubDailySpec} data={rows} />
      )}
    </div>
  )
}
