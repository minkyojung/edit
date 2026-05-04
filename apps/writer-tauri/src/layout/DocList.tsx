// Sidebar list of daily journal entries with their nested writing
// children. Daily rows are the time-axis spine; under each daily,
// any note whose parentId points at it (or, recursively, at one of
// its descendants) hangs as a tree branch.
//
// Today is always pinned at the top and expanded by default. Other
// days collapse for visual quiet — the user opens them on demand.
// Empty days still show in the rolling window so the user can
// backfill, matching the "every date is a slot" model from the
// design doc.

import { useMemo, useState, type MouseEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconCalendar, IconChevronRight, IconFileText, IconPlus } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocTitle } from '@/hooks/useDocTitle'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'

const RECENT_DAYS = 7

export function DocList() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setActive = useDocsStore((s) => s.setActive)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const today = todayLocalDate()
  // Track which daily rows are expanded. Today defaults to expanded;
  // the rest collapse so the sidebar stays scannable. The state lives
  // in component-local React state — refreshing the app starts every
  // day folded again except today, which the design accepts as a
  // visual quiet default.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([today]))

  const rows = useMemo(() => buildDailyRows(knownDocs), [knownDocs])
  const childrenByParent = useMemo(() => indexChildren(knownDocs), [knownDocs])

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const toggleExpand = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  return (
    <div className="px-2 py-2">
      <div className="px-2 pb-1 text-xs font-medium text-muted-foreground/70">
        Daily
      </div>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const dailySlug = row.slug
          const isActive = dailySlug ? dailySlug === activeSlug : false
          const isExpanded = expanded.has(row.date)
          const children = dailySlug ? childrenByParent.get(dailySlug) ?? [] : []
          const hasChildren = children.length > 0

          return (
            <li key={row.date}>
              <DailyRow
                row={row}
                isActive={isActive}
                isExpanded={isExpanded}
                hasChildren={hasChildren}
                onToggleExpand={() => toggleExpand(row.date)}
                onSelect={async () => {
                  const slug = await openDaily(row.date)
                  // Expand on open so the user sees what's inside.
                  if (slug) {
                    setExpanded((prev) => new Set(prev).add(row.date))
                  }
                  ensureNotesRoute()
                }}
                onAddChild={async () => {
                  // Make sure the daily exists before nesting under it.
                  const parent = await openDaily(row.date)
                  if (!parent) return
                  await createChildNote(parent)
                  setExpanded((prev) => new Set(prev).add(row.date))
                  ensureNotesRoute()
                }}
              />

              {dailySlug && isExpanded && hasChildren && (
                <ul className="flex flex-col gap-0.5 pt-0.5">
                  {children.map((child) => (
                    <DocTreeNode
                      key={child.slug}
                      doc={child}
                      depth={1}
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
                    />
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
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
  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-xs transition-colors',
        isActive
          ? 'bg-accent text-foreground'
          : row.hasEntry
            ? 'text-foreground/80 hover:bg-accent/50 hover:text-foreground'
            : 'text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {/* Expand chevron — only meaningful when there are children. We
          render a fixed-width spacer otherwise so daily rows align
          column-wise regardless of child count. */}
      <button
        type="button"
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          if (hasChildren) onToggleExpand()
        }}
        aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
        tabIndex={hasChildren ? 0 : -1}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          hasChildren ? 'hover:text-foreground' : 'opacity-0',
        )}
      >
        <IconChevronRight
          size={10}
          className="transition-transform"
          style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
      </button>

      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
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
  depth,
  childrenByParent,
  activeSlug,
  onSelect,
  onAddChild,
}: {
  doc: KnownDoc
  depth: number
  childrenByParent: Map<string, KnownDoc[]>
  activeSlug: string | null
  onSelect: (slug: string) => void
  onAddChild: (parentSlug: string) => void
}) {
  const handle = useDocsStore((s) => s.handles[doc.slug])
  const { title } = useDocTitle(handle?.ydoc ?? null)
  const children = childrenByParent.get(doc.slug) ?? []
  const hasChildren = children.length > 0
  const [isExpanded, setIsExpanded] = useState(false)
  const isActive = doc.slug === activeSlug

  return (
    <li>
      <div
        className={cn(
          'group flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-xs transition-colors',
          isActive
            ? 'bg-accent text-foreground'
            : 'text-foreground/80 hover:bg-accent/50 hover:text-foreground',
        )}
        // Indent by depth — each level adds a small step so the tree
        // structure reads at a glance without dominating row width.
        style={{ paddingLeft: `${0.375 + depth * 0.875}rem` }}
      >
        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            if (hasChildren) setIsExpanded((v) => !v)
          }}
          aria-label={hasChildren ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
          tabIndex={hasChildren ? 0 : -1}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            hasChildren ? 'hover:text-foreground' : 'opacity-0',
          )}
        >
          <IconChevronRight
            size={10}
            className="transition-transform"
            style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        </button>

        <button
          type="button"
          onClick={() => onSelect(doc.slug)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring/40 rounded',
          )}
        >
          <IconFileText
            size={12}
            stroke={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <span className="truncate">{title || 'Untitled'}</span>
        </button>

        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            onAddChild(doc.slug)
            setIsExpanded(true)
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
        <ul className="flex flex-col gap-0.5 pt-0.5">
          {children.map((child) => (
            <DocTreeNode
              key={child.slug}
              doc={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              activeSlug={activeSlug}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

interface DailyRowMeta {
  date: string
  label: string
  isToday: boolean
  hasEntry: boolean
  slug: string | null
}

function buildDailyRows(knownDocs: KnownDoc[]): DailyRowMeta[] {
  const today = todayLocalDate()
  const dailies = new Map<string, string>()
  for (const d of knownDocs) {
    if (d.type === 'daily' && d.date) dailies.set(d.date, d.slug)
  }

  const windowDates: string[] = []
  const base = new Date()
  for (let i = 0; i < RECENT_DAYS; i += 1) {
    const dt = new Date(base)
    dt.setDate(base.getDate() - i)
    windowDates.push(formatLocalDate(dt))
  }

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
