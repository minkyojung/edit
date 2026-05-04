// Sidebar list of daily journal entries — the writer's primary
// navigation. Renders Today first, then the most recent six days
// (so the visible window covers a full week with today on top).
// Days that have no entry yet still show up at low contrast and
// can be clicked to backfill — the daily journal model treats every
// day as a slot, not just the ones you've already written in.
//
// Future phases:
//   - 'Older' month-fold below Recent.
//   - Tree of writing-type children under each daily.
//   - Tag filter chips.

import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconCalendar } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'

const RECENT_DAYS = 7

export function DocList() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // Build the visible date window (today → today - 6) plus any older
  // dailies the user actually has, so going back into the past stays
  // possible without needing a calendar yet.
  const rows = useMemo(() => buildDailyRows(knownDocs), [knownDocs])

  return (
    <div className="px-2 py-2">
      <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/70">
        Daily
      </div>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const isActive = row.slug ? row.slug === activeSlug : false
          return (
            <li key={row.date}>
              <button
                type="button"
                onClick={() => {
                  openDaily(row.date).catch((err) =>
                    console.error('[docs] openDaily failed', err),
                  )
                  // If the user clicked a daily while looking at /wiki
                  // (or any non-editor route), pop them back into the
                  // editor so the active doc is what they see.
                  if (!pathname.startsWith('/notes')) navigate('/notes')
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  isActive
                    ? 'bg-accent text-foreground'
                    : row.hasEntry
                      ? 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
                      : 'text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground',
                )}
              >
                <IconCalendar
                  size={12}
                  stroke={1.75}
                  className="shrink-0"
                  aria-hidden
                />
                <span className="truncate">{row.label}</span>
                {row.isToday && (
                  <span className="ml-auto shrink-0 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                    Today
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface DailyRow {
  date: string
  label: string
  isToday: boolean
  hasEntry: boolean
  slug: string | null
}

function buildDailyRows(knownDocs: { slug: string; type: string; date?: string }[]): DailyRow[] {
  const today = todayLocalDate()
  const dailies = new Map<string, string>() // date → slug
  for (const d of knownDocs) {
    if (d.type === 'daily' && d.date) dailies.set(d.date, d.slug)
  }

  // Build the rolling window of recent dates first.
  const windowDates: string[] = []
  const base = new Date()
  for (let i = 0; i < RECENT_DAYS; i += 1) {
    const dt = new Date(base)
    dt.setDate(base.getDate() - i)
    windowDates.push(formatLocalDate(dt))
  }

  // Then merge in any older dailies the user actually has, so the
  // sidebar doesn't hide their history. They sort below the rolling
  // window since they're past the recent boundary.
  const olderDates = Array.from(dailies.keys())
    .filter((d) => !windowDates.includes(d))
    .sort()
    .reverse()

  return [...windowDates, ...olderDates].map((date) => ({
    date,
    label: labelForDate(date, today),
    isToday: date === today,
    hasEntry: dailies.has(date),
    slug: dailies.get(date) ?? null,
  }))
}

function labelForDate(date: string, today: string): string {
  if (date === today) {
    return new Date(date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  }
  const d = new Date(date)
  const t = new Date(today)
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86_400_000)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays > 0 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}),
  })
}
