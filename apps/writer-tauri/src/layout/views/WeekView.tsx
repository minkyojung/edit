// Week tab — sliding 7 days ending at today. The recent-review
// surface: scan what was written this past week, jump in, fill
// gaps. Intentionally a flat list (no child tree, no week label)
// so the eye can sweep dates linearly. Tree access for any day
// belongs in the Day tab once that day is active.
//
// Today gets a soft accent background + foreground text so it
// reads as the anchor of the strip; days with no entry yet dim
// down so the gap is visible without shouting.

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'

const DAYS_IN_WEEK = 7

export function WeekView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setSidebarTab = useDocsStore((s) => s.setSidebarTab)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const today = todayLocalDate()

  // Build sliding 7 days: today at top, six days back. Indexed by
  // YYYY-MM-DD against the known dailies for an O(1) hasEntry check.
  const dailyByDate = useMemo(() => {
    const map = new Map<string, string>() // date → slug
    for (const d of knownDocs) {
      if (d.archivedAt) continue
      if (d.type === 'daily' && d.date) map.set(d.date, d.slug)
    }
    return map
  }, [knownDocs])

  const rows = useMemo(() => {
    const out: Row[] = []
    for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
      const date = addDays(today, -i)
      out.push(buildRow(date, today, dailyByDate))
    }
    return out
  }, [today, dailyByDate])

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  return (
    <ul className="flex flex-col gap-0.5 px-1">
      {rows.map((row) => (
        <li key={row.date}>
          <DayRow
            row={row}
            isActive={row.slug ? row.slug === activeSlug : false}
            onSelect={async () => {
              const slug = await openDaily(row.date)
              if (slug) {
                // Jumping to a specific day reads as "I want to work
                // this day" — drop the user into Day view so they get
                // the full tree + new-note affordance.
                setSidebarTab('day')
              }
              ensureNotesRoute()
            }}
          />
        </li>
      ))}
    </ul>
  )
}

interface Row {
  date: string
  /** Short month + day (e.g. "May 6"). */
  label: string
  /** 3-letter weekday (e.g. "Tue"). */
  weekday: string
  isToday: boolean
  hasEntry: boolean
  slug: string | null
}

function buildRow(
  date: string,
  today: string,
  dailyByDate: Map<string, string>,
): Row {
  const d = new Date(date)
  return {
    date,
    label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    isToday: date === today,
    hasEntry: dailyByDate.has(date),
    slug: dailyByDate.get(date) ?? null,
  }
}

function DayRow({
  row,
  isActive,
  onSelect,
}: {
  row: Row
  isActive: boolean
  onSelect: () => void
}) {
  const isEmpty = !row.hasEntry && !row.isToday
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        row.isToday
          ? 'bg-accent text-foreground'
          : isActive
            ? 'bg-accent/60 text-foreground'
            : isEmpty
              ? 'text-muted-foreground/45 hover:bg-accent/40 hover:text-muted-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <span className="truncate">{row.label}</span>
      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
        {row.weekday}
      </span>
    </button>
  )
}

function addDays(dateISO: string, n: number): string {
  const d = new Date(dateISO)
  d.setDate(d.getDate() + n)
  return formatLocalDate(d)
}
