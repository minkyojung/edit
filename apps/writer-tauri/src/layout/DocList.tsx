// Sidebar list of daily journal entries, grouped by calendar week.
// Daily rows are the time-axis spine; under each daily, any note
// whose parentId points at it hangs as a tree branch.
//
// The current week ("This week") gets all 7 day slots — empty days
// included — so the user can backfill at any time. Past weeks show
// only days that actually have entries; empty past days are visual
// noise and the past path is now ⌘G + the persisted activity, not
// a calendar-roll. This matches the "Capture (today) vs Review
// (past)" mode separation.
//
// Past weeks default to collapsed; This week defaults to expanded.
// User toggle state lives in docsStore.expandedWeekStarts and is
// persisted, so the user's fold layout survives a reload.

import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconArchive,
  IconCalendar,
  IconChevronRight,
  IconFileDescription,
  IconPlus,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, isWikiDoc, weekStartFor, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'

export function DocList() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setActive = useDocsStore((s) => s.setActive)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const expandedDocSlugs = useDocsStore((s) => s.expandedDocSlugs)
  const toggleExpanded = useDocsStore((s) => s.toggleExpanded)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // Archived docs live in knownDocs but are pulled out of the live
  // tree so the sidebar reflects only what the user is actively
  // working with. They reappear via the Archived popover above the
  // profile button.
  // Wiki docs (belief / entity / episode) are pulled out too — they
  // render under their own section below so the daily tree stays
  // a pure timeline of user-authored notes.
  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && !isWikiDoc(d)),
    [knownDocs],
  )
  const wikiDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && isWikiDoc(d)),
    [knownDocs],
  )

  const expandedWeekStarts = useDocsStore((s) => s.expandedWeekStarts)
  const toggleWeekExpanded = useDocsStore((s) => s.toggleWeekExpanded)

  const weekGroups = useMemo(() => buildWeekGroups(liveDocs), [liveDocs])
  const childrenByParent = useMemo(() => indexChildren(liveDocs), [liveDocs])
  const expandedWeekSet = useMemo(
    () => new Set(expandedWeekStarts),
    [expandedWeekStarts],
  )

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  // Expansion state lives in the docs store (persisted), keyed by
  // slug. Today's slug is force-added during bootstrap so the
  // current day always greets the user expanded; everything else
  // remembers the user's last fold state.
  const expandedSet = useMemo(
    () => new Set(expandedDocSlugs),
    [expandedDocSlugs],
  )

  // After the active doc changes (e.g. ⌘G jumped to a date in a
  // collapsed week), bring its row into view. Use a containing-list
  // ref + querySelector so we don't have to manage a ref per row.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!activeSlug) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-slug="${CSS.escape(activeSlug)}"]`,
    )
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeSlug])

  return (
    <div ref={listRef} className="px-2 py-2">
      <div className="px-2 pb-1 text-[13px] font-medium text-muted-foreground">
        Daily
      </div>
      <ul className="flex flex-col gap-1">
        {weekGroups.map((group) => {
          const isWeekExpanded = expandedWeekSet.has(group.weekStart)
          return (
            <li key={group.weekStart}>
              <WeekHeader
                group={group}
                isExpanded={isWeekExpanded}
                onToggle={() => toggleWeekExpanded(group.weekStart)}
              />
              {isWeekExpanded && (
                <ul className="flex flex-col gap-0.5 pt-0.5">
                  {group.rows.map((row) => {
                    const dailySlug = row.slug
                    const isActive = dailySlug
                      ? dailySlug === activeSlug
                      : false
                    const isExpanded = dailySlug
                      ? expandedSet.has(dailySlug)
                      : false
                    const children = dailySlug
                      ? childrenByParent.get(dailySlug) ?? []
                      : []
                    const hasChildren = children.length > 0
                    return (
                      <li key={row.date} data-slug={dailySlug ?? ''}>
                        <DailyRow
                          row={row}
                          isActive={isActive}
                          isExpanded={isExpanded}
                          hasChildren={hasChildren}
                          onToggleExpand={() => {
                            if (dailySlug) toggleExpanded(dailySlug)
                          }}
                          onSelect={async () => {
                            const slug = await openDaily(row.date)
                            if (slug && !expandedSet.has(slug))
                              toggleExpanded(slug)
                            ensureNotesRoute()
                          }}
                          onAddChild={async () => {
                            const parent = await openDaily(row.date)
                            if (!parent) return
                            await createChildNote(parent)
                            if (!expandedSet.has(parent))
                              toggleExpanded(parent)
                            ensureNotesRoute()
                          }}
                        />
                        {dailySlug && isExpanded && hasChildren && (
                          <ul className="ml-3.5 flex flex-col gap-0.5 border-l border-border pt-0.5">
                            {children.map((child) => (
                              <DocTreeNode
                                key={child.slug}
                                doc={child}
                                childrenByParent={childrenByParent}
                                activeSlug={activeSlug}
                                onSelect={(slug) => {
                                  setActive(slug)
                                  ensureNotesRoute()
                                }}
                                onAddChild={async (parentSlug) => {
                                  await createChildNote(parentSlug)
                                  ensureNotesRoute()
                                }}
                                onArchive={(slug) => {
                                  useDocsStore.getState().archiveDoc(slug)
                                }}
                              />
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ul>

      {wikiDocs.length > 0 && (
        <div className="pt-3">
          <div className="px-2 pb-1 text-[13px] font-medium text-muted-foreground">
            Wiki
          </div>
          <ul className="flex flex-col gap-0.5">
            {wikiDocs.map((doc) => (
              <li key={doc.slug} data-slug={doc.slug}>
                <WikiRow
                  doc={doc}
                  isActive={doc.slug === activeSlug}
                  onSelect={() => {
                    setActive(doc.slug)
                    ensureNotesRoute()
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function WikiRow({
  doc,
  isActive,
  onSelect,
}: {
  doc: KnownDoc
  isActive: boolean
  onSelect: () => void
}) {
  const label = useDocLabel(doc.slug)
  // Strip the `wiki:` prefix for a tidy default when the doc has no
  // user-set title yet ("belief" reads better than "wiki:belief").
  const fallback = doc.type.replace(/^wiki:/, '')
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
        aria-hidden
      >
        <IconFileDescription size={12} stroke={1.75} />
      </span>
      <span className="truncate">{label || fallback}</span>
    </button>
  )
}

interface WeekGroup {
  weekStart: string
  weekEnd: string
  /** True iff the week contains today. */
  isCurrent: boolean
  /** True iff the week is exactly the one before the current. */
  isLastWeek: boolean
  /** Daily rows to render. Current week has all 7 slots; past weeks
   * have only days that actually have entries. */
  rows: DailyRowMeta[]
  /** How many days in the week have a real daily entry. */
  entryCount: number
}

function WeekHeader({
  group,
  isExpanded,
  onToggle,
}: {
  group: WeekGroup
  isExpanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium uppercase tracking-wide text-muted-foreground/80 transition-colors',
        'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <IconChevronRight
        size={10}
        stroke={1.75}
        className="shrink-0 transition-transform"
        style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
      />
      <span className="flex-1 truncate normal-case tracking-normal">
        {weekHeaderLabel(group)}
      </span>
      {group.entryCount > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {group.entryCount}
        </span>
      )}
    </button>
  )
}

function weekHeaderLabel(group: WeekGroup): string {
  if (group.isCurrent) return 'This week'
  if (group.isLastWeek) return 'Last week'
  return `${formatRange(group.weekStart, group.weekEnd)}`
}

function formatRange(startISO: string, endISO: string): string {
  const start = new Date(startISO)
  const end = new Date(endISO)
  const today = new Date(todayLocalDate())
  const sameYearAsToday =
    start.getFullYear() === today.getFullYear() &&
    end.getFullYear() === today.getFullYear()
  const startLabel = start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  const endLabel = end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYearAsToday ? {} : { year: 'numeric' }),
  })
  return `${startLabel} — ${endLabel}`
}

interface DailyRowProps {
  row: DailyRowMeta
  isActive: boolean
  isExpanded: boolean
  hasChildren: boolean
  onToggleExpand: () => void
  onSelect: () => void
  onAddChild: () => void
}

function DailyRow({
  row,
  isActive,
  isExpanded,
  hasChildren,
  onToggleExpand,
  onSelect,
  onAddChild,
}: DailyRowProps) {
  // Empty day in This week is a real slot the user can fill, but it
  // shouldn't read as the same weight as a day with content. Drop
  // the row's text tone a step so "yesterday I wrote, day before I
  // didn't" is legible at a glance. Today and active rows always
  // win — they keep their full emphasis no matter what.
  const isEmpty = !row.hasEntry && !row.isToday
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-[13px] font-medium transition-colors',
        isActive
          ? 'bg-accent text-foreground'
          : isEmpty
            ? 'text-muted-foreground/45 hover:bg-accent/40 hover:text-muted-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {/* Leading slot: chevron when expandable, calendar icon otherwise.
          Chevron replaces the icon so each row has exactly one symbol
          before the label. */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground',
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
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70',
            isEmpty && 'opacity-60',
          )}
          aria-hidden
        >
          <IconCalendar size={12} stroke={1.75} />
        </span>
      )}

      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
        )}
      >
        <span className="truncate">{row.label}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {row.weekday}
        </span>
      </button>

      {/* Add-child button reveals on hover so the resting state stays
          quiet. Always reachable by keyboard once a row is focused. */}
      <button
        type="button"
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onAddChild()
        }}
        aria-label="Add note"
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded',
          'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground',
          'group-hover:opacity-60 focus-visible:opacity-100',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <IconPlus size={10} stroke={2} />
      </button>
    </div>
  )
}

function DocTreeNode({
  doc,
  childrenByParent,
  activeSlug,
  onSelect,
  onAddChild,
  onArchive,
}: {
  doc: KnownDoc
  childrenByParent: Map<string, KnownDoc[]>
  activeSlug: string | null
  onSelect: (slug: string) => void
  onAddChild: (parentSlug: string) => void
  onArchive: (slug: string) => void
}) {
  const label = useDocLabel(doc.slug)
  const expandedDocSlugs = useDocsStore((s) => s.expandedDocSlugs)
  const toggleExpanded = useDocsStore((s) => s.toggleExpanded)
  const children = childrenByParent.get(doc.slug) ?? []
  const hasChildren = children.length > 0
  const isExpanded = expandedDocSlugs.includes(doc.slug)
  const isActive = doc.slug === activeSlug

  return (
    <li>
      <div
        className={cn(
          'group flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-[13px] font-medium transition-colors',
          isActive
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              toggleExpanded(doc.slug)
            }}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground',
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
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
            aria-hidden
          >
            <IconFileDescription size={12} stroke={1.75} />
          </span>
        )}

        <button
          type="button"
          onClick={() => onSelect(doc.slug)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
          )}
        >
          <span className="truncate">{label}</span>
        </button>

        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onArchive(doc.slug)
          }}
          aria-label="Archive note"
          title="Archive"
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground',
            'group-hover:opacity-60 focus-visible:opacity-100',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconArchive size={10} stroke={1.75} />
        </button>

        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onAddChild(doc.slug)
            if (!isExpanded) toggleExpanded(doc.slug)
          }}
          aria-label="Add note"
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded',
            'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground',
            'group-hover:opacity-60 focus-visible:opacity-100',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconPlus size={10} stroke={2} />
        </button>
      </div>

      {isExpanded && hasChildren && (
        <ul className="ml-3.5 flex flex-col gap-0.5 border-l border-border pt-0.5">
          {children.map((child) => (
            <DocTreeNode
              key={child.slug}
              doc={child}
              childrenByParent={childrenByParent}
              activeSlug={activeSlug}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onArchive={onArchive}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

interface DailyRowMeta {
  date: string
  /** Numeric date label for the leading column (e.g. "May 5"). */
  label: string
  /** Weekday abbreviation for the trailing column (e.g. "Tue"). */
  weekday: string
  isToday: boolean
  hasEntry: boolean
  slug: string | null
}

/** Group dailies by calendar week (Sunday-anchored). The current
 * week always renders all 7 day slots so the user can backfill;
 * past weeks include only days that actually have an entry — empty
 * past days are visual noise and the past-day path is ⌘G now.
 *
 * Weeks are sorted newest-first. Past weeks with zero entries are
 * dropped entirely (they'd be an infinite tail of nothing). */
function buildWeekGroups(knownDocs: KnownDoc[]): WeekGroup[] {
  const today = todayLocalDate()
  const currentWeekStart = weekStartFor(today)
  const lastWeekStart = shiftWeek(currentWeekStart, -1)

  // Map date → slug for daily entries (writing entries are filed by
  // parentId, not date).
  const dailies = new Map<string, string>()
  for (const d of knownDocs) {
    if (d.type === 'daily' && d.date) dailies.set(d.date, d.slug)
  }

  // Group entry dates by their week-start. Skip future weeks —
  // sidebar is past+present only.
  const entriesByWeek = new Map<string, string[]>()
  for (const date of dailies.keys()) {
    const ws = weekStartFor(date)
    if (ws > currentWeekStart) continue
    const list = entriesByWeek.get(ws)
    if (list) list.push(date)
    else entriesByWeek.set(ws, [date])
  }
  // Make sure the current week shows even if it has no entry yet.
  if (!entriesByWeek.has(currentWeekStart))
    entriesByWeek.set(currentWeekStart, [])

  const weekStarts = Array.from(entriesByWeek.keys()).sort().reverse()

  return weekStarts.map((weekStart) => {
    const weekEnd = addDays(weekStart, 6)
    const isCurrent = weekStart === currentWeekStart
    const isLastWeek = weekStart === lastWeekStart
    const entryDates = entriesByWeek.get(weekStart) ?? []

    let rows: DailyRowMeta[]
    if (isCurrent) {
      // All 7 slots, Sun → Mon top-to-bottom (newest-first within
      // a Mon-anchored week). Backfill seeds every day so the row
      // always represents a real doc.
      const dates: string[] = []
      for (let i = 6; i >= 0; i -= 1) dates.push(addDays(weekStart, i))
      rows = dates.map((date) => buildDailyRow(date, today, dailies))
    } else {
      // Past week: only days with entries, newest-first.
      rows = [...entryDates]
        .sort()
        .reverse()
        .map((date) => buildDailyRow(date, today, dailies))
    }

    return {
      weekStart,
      weekEnd,
      isCurrent,
      isLastWeek,
      rows,
      entryCount: entryDates.length,
    }
  })
}

function buildDailyRow(
  date: string,
  today: string,
  dailies: Map<string, string>,
): DailyRowMeta {
  const d = new Date(date)
  return {
    date,
    label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
    isToday: date === today,
    hasEntry: dailies.has(date),
    slug: dailies.get(date) ?? null,
  }
}

function addDays(dateISO: string, n: number): string {
  const d = new Date(dateISO)
  d.setDate(d.getDate() + n)
  return formatLocalDate(d)
}

function shiftWeek(weekStartISO: string, weeks: number): string {
  return addDays(weekStartISO, weeks * 7)
}

/** Group writing-type docs by their parentId so each daily / writing
 * node can fetch its direct children in O(1). Children are sorted by
 * slug as a stable-but-arbitrary order; v2 will swap this for an
 * explicit ordering field once we ship drag-to-reorder. */
function indexChildren(knownDocs: KnownDoc[]): Map<string, KnownDoc[]> {
  const out = new Map<string, KnownDoc[]>()
  for (const d of knownDocs) {
    if (!d.parentId) continue
    const list = out.get(d.parentId)
    if (list) list.push(d)
    else out.set(d.parentId, [d])
  }
  for (const list of out.values()) list.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

