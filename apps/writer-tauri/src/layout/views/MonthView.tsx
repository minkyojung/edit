// Month tab — 7-column calendar grid for the anchor month. The
// far-review surface: see the shape of an entire month at once,
// jump to any day. Implemented locally instead of pulling in
// react-day-picker because (a) we need a dot marker per day with
// content, (b) cells are sidebar-tight (~30px), and (c) the picker
// chrome is overkill for what is really a navigable timeline.
//
// Clicking a cell jumps to that daily and flips to the Day tab —
// "I want this day" reads as a request to work it, not just peek.

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { SidebarGroup } from '@/components/ui/sidebar'

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

export function MonthView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const shiftMonth = useDocsStore((s) => s.shiftMonth)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setSidebarTab = useDocsStore((s) => s.setSidebarTab)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const today = todayLocalDate()

  const dailyDates = useMemo(() => {
    const set = new Set<string>()
    for (const d of knownDocs) {
      if (d.archivedAt) continue
      if (d.type === 'daily' && d.date) set.add(d.date)
    }
    return set
  }, [knownDocs])

  const weeks = useMemo(
    () => buildMonthGrid(monthAnchor, today, dailyDates),
    [monthAnchor, today, dailyDates],
  )
  const headerLabel = useMemo(() => formatMonthHeader(monthAnchor), [monthAnchor])

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const handlePick = async (date: string) => {
    const slug = await openDaily(date)
    if (slug) setSidebarTab('day')
    ensureNotesRoute()
  }

  return (
    <SidebarGroup className="p-0 px-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-sm transition-colors',
            'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
          )}
        >
          <IconChevronLeft size={12} stroke={1.75} />
        </button>
        <span className="text-xs font-medium text-sidebar-foreground">
          {headerLabel}
        </span>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-sm transition-colors',
            'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
          )}
        >
          <IconChevronRight size={12} stroke={1.75} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-0.5 pb-1">
        {WEEKDAY_LABELS.map((label, i) => (
          <div
            key={i}
            className="flex h-5 items-center justify-center text-[10px] font-medium text-sidebar-foreground/50"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-0.5">
        {weeks.flat().map((cell, i) =>
          cell.date ? (
            <button
              key={cell.date}
              type="button"
              onClick={() => handlePick(cell.date!)}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center rounded-md text-xs tabular-nums transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40',
                cell.isToday
                  ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground'
                  : cell.hasEntry
                    ? 'font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
                    : 'font-medium text-sidebar-foreground/35 hover:bg-sidebar-accent/30 hover:text-sidebar-foreground/70',
              )}
            >
              <span className="leading-none">{cell.day}</span>
              {cell.hasEntry && !cell.isToday && (
                <span
                  className="absolute bottom-1 h-[3px] w-[3px] rounded-full bg-sidebar-foreground/70"
                  aria-hidden
                />
              )}
            </button>
          ) : (
            <div key={`blank-${i}`} aria-hidden />
          ),
        )}
      </div>
    </SidebarGroup>
  )
}

interface MonthCell {
  /** YYYY-MM-DD when the cell is a real day in this month, null when
   * it's a leading/trailing blank used to fill the 7×N grid. */
  date: string | null
  /** 1-31 day number when date is set. */
  day?: number
  isToday?: boolean
  hasEntry?: boolean
}

/** Build the 7×N grid for a YYYY-MM anchor with Sunday-start week
 * convention. Leading blanks fill the cells before the 1st; trailing
 * blanks pad the last row out to a multiple of 7 so the grid keeps a
 * clean rectangle. */
function buildMonthGrid(
  anchor: string,
  today: string,
  dailyDates: Set<string>,
): MonthCell[][] {
  const [yStr, mStr] = anchor.split('-')
  const year = Number(yStr)
  const monthIdx = Number(mStr) - 1 // 0-indexed
  const firstOfMonth = new Date(year, monthIdx, 1)
  const leading = firstOfMonth.getDay() // 0=Sun … 6=Sat
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate()
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7

  const cells: MonthCell[] = []
  for (let i = 0; i < totalCells; i += 1) {
    const dayNum = i - leading + 1
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push({ date: null })
      continue
    }
    const mm = String(monthIdx + 1).padStart(2, '0')
    const dd = String(dayNum).padStart(2, '0')
    const date = `${year}-${mm}-${dd}`
    cells.push({
      date,
      day: dayNum,
      isToday: date === today,
      hasEntry: dailyDates.has(date),
    })
  }

  const rows: MonthCell[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7))
  }
  return rows
}

/** "May 2026" — short month + year. Year is always shown so the user
 * doesn't lose place after stepping ◀ across a January/December
 * boundary. */
function formatMonthHeader(anchor: string): string {
  const [yStr, mStr] = anchor.split('-')
  const d = new Date(Number(yStr), Number(mStr) - 1, 1)
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}
