// Week tab — sliding 7 days ending at today. The recent-review surface:
// scan what was written this past week, jump in, fill gaps.
//
// Days with child notes show a caret + count and expand inline as a
// tree; this is the "peek" gesture — see what's in a day without
// committing to switch surfaces. The label click is reserved for the
// "go work this day" gesture (jumps to Day view at that anchor).
// Splitting these two clicks lets one row carry both intents without
// the user having to remember a modifier.
//
// Today gets a soft accent background + foreground text so it reads as
// the anchor of the strip; days with no entry yet dim down so the gap
// is visible without shouting.

import { useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconChevronRight } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'
import { DocTreeNode, indexChildren } from '../DocTreeNode'

const DAYS_IN_WEEK = 7

export function WeekView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setActive = useDocsStore((s) => s.setActive)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const setSidebarTab = useDocsStore((s) => s.setSidebarTab)
  const setDayAnchor = useDocsStore((s) => s.setDayAnchor)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // Expansion state is local to Week view — peeking into a day from
  // the week strip is an in-the-moment gesture, not something we want
  // surviving a reload. Keeps the global expandedDocSlugs set clean
  // (that one tracks per-doc tree folds inside Day view).
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const toggleExpanded = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const today = todayLocalDate()

  // Build the parent → children index once. Used both for child counts
  // on each row and for the recursive DocTreeNode render when a row is
  // expanded.
  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && !d.type.startsWith('wiki:')),
    [knownDocs],
  )
  const childrenByParent = useMemo(() => indexChildren(liveDocs), [liveDocs])

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
      out.push(buildRow(date, today, dailyByDate, childrenByParent))
    }
    return out
  }, [today, dailyByDate, childrenByParent])

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((row) => {
        const isExpanded = expandedDates.has(row.date)
        const children = row.slug
          ? childrenByParent.get(row.slug) ?? []
          : []
        return (
          <li key={row.date}>
            <DayRow
              row={row}
              isActive={row.slug ? row.slug === activeSlug : false}
              isExpanded={isExpanded}
              onToggle={() => toggleExpanded(row.date)}
              onJump={async () => {
                const slug = await openDaily(row.date)
                if (slug) {
                  // Jumping to a specific day reads as "I want to work
                  // this day" — drop the user into Day view at that
                  // anchor so the prev/next chevrons continue from
                  // where they picked.
                  setDayAnchor(row.date)
                  setSidebarTab('day')
                }
                ensureNotesRoute()
              }}
            />
            {isExpanded && children.length > 0 && (
              <ul className="relative flex flex-col gap-0.5 pt-0.5">
                <span
                  aria-hidden
                  className="absolute left-2 top-0.5 bottom-0 w-px bg-border"
                />
                {children.map((child) => (
                  <DocTreeNode
                    key={child.slug}
                    doc={child}
                    childrenByParent={childrenByParent}
                    activeSlug={activeSlug}
                    depth={1}
                    onSelect={(slug) => {
                      setActive(slug)
                      ensureNotesRoute()
                    }}
                    onAddChild={async (parentSlug) => {
                      await createChildNote(parentSlug)
                      ensureNotesRoute()
                    }}
                    onArchive={(slug) => archiveDoc(slug)}
                  />
                ))}
              </ul>
            )}
          </li>
        )
      })}
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
  /** Number of direct child notes filed under this day's daily. Zero
   * when the daily doesn't exist or has no children. */
  childCount: number
}

function buildRow(
  date: string,
  today: string,
  dailyByDate: Map<string, string>,
  childrenByParent: Map<string, KnownDoc[]>,
): Row {
  const d = new Date(date)
  const slug = dailyByDate.get(date) ?? null
  const childCount = slug ? childrenByParent.get(slug)?.length ?? 0 : 0
  return {
    date,
    label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    isToday: date === today,
    hasEntry: dailyByDate.has(date),
    slug,
    childCount,
  }
}

function DayRow({
  row,
  isActive,
  isExpanded,
  onToggle,
  onJump,
}: {
  row: Row
  isActive: boolean
  isExpanded: boolean
  onToggle: () => void
  onJump: () => void
}) {
  const isEmpty = !row.hasEntry && !row.isToday
  const hasChildren = row.childCount > 0
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 px-1.5 py-1.5 text-[13px] font-medium transition-colors',
        'outline-none',
        row.isToday
          ? 'bg-accent text-foreground'
          : isActive
            ? 'bg-accent/60 text-foreground'
            : isEmpty
              ? 'text-muted-foreground/45 hover:bg-accent/40 hover:text-muted-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {/* Caret slot — reserved width even when empty so labels align
          across rows regardless of whether each day has children. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          aria-label={isExpanded ? 'Collapse day' : 'Expand day'}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'text-muted-foreground/70 hover:text-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconChevronRight
            size={12}
            stroke={1.75}
            className="transition-transform"
            style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}

      <button
        type="button"
        onClick={onJump}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
        )}
      >
        <span className="truncate">{row.label}</span>
        <span
          className={cn(
            'ml-auto shrink-0 text-[11px] tabular-nums',
            hasChildren ? 'text-muted-foreground' : 'text-muted-foreground/70',
          )}
        >
          {hasChildren ? `${row.childCount} · ${row.weekday}` : row.weekday}
        </span>
      </button>
    </div>
  )
}

function addDays(dateISO: string, n: number): string {
  const d = new Date(dateISO)
  d.setDate(d.getDate() + n)
  return formatLocalDate(d)
}
