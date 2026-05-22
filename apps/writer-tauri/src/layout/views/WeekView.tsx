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
//
// Structurally the row uses shadcn primitives composed Cursor-style:
// SidebarMenuButton carries the full-row "jump" action; the leading
// slot at the left (an absolute overlay over the button's pl-8
// padding) holds either a CollapsibleTrigger chevron (when the day
// has child notes) or a plain calendar glyph (when it doesn't), so
// the slot communicates "expandable subtree" vs "leaf day" the same
// way DocTreeNode does. Children render inside CollapsibleContent →
// SidebarMenuSub for automatic indentation and the vertical guide.

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconCalendar, IconChevronRight } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, isWikiDoc, type KnownDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'
import { buildDayUrl, buildWeekUrl } from '@/lib/viewUrl'
import { DocTreeNode, indexChildren } from '../DocTreeNode'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from '@/components/ui/sidebar'
import {
  TreeRow,
  TreeRowLabel,
  TreeRowLead,
  TreeSub,
} from '@/components/ui/tree-row'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

const DAYS_IN_WEEK = 7

export function WeekView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const openDaily = useDocsStore((s) => s.openDaily)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const navigate = useNavigate()

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
    () => knownDocs.filter((d) => !d.archivedAt && !isWikiDoc(d)),
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

  const onJump = async (row: Row) => {
    // Jumping to a specific day reads as "I want to work this day" —
    // drop the user into Day view at that anchor so the prev/next
    // chevrons continue from where they picked. The URL carries both
    // the new anchor and the resolved slug; useRouteSync mirrors them
    // into the store on the next tick.
    const slug = await openDaily(row.date)
    navigate(buildDayUrl(row.date, slug ?? activeSlug))
  }

  return (
    <SidebarGroup className="p-0">
      <SidebarGroupContent className="px-2">
        <SidebarMenu>
          {rows.map((row) => {
            const isExpanded = expandedDates.has(row.date)
            const subChildren = row.slug
              ? childrenByParent.get(row.slug) ?? []
              : []
            return (
              <DayItem
                key={row.date}
                row={row}
                isActive={row.slug ? row.slug === activeSlug : false}
                isExpanded={isExpanded}
                subChildren={subChildren}
                childrenByParent={childrenByParent}
                activeSlug={activeSlug}
                onJump={() => onJump(row)}
                onToggle={() => toggleExpanded(row.date)}
                onSelectChild={(slug) => navigate(buildWeekUrl(slug))}
                onAddChild={async (parentSlug) => {
                  const created = await createChildNote(parentSlug)
                  if (created) navigate(buildWeekUrl(created))
                }}
                onArchive={(slug) => {
                  const next = archiveDoc(slug)
                  if (next) navigate(buildWeekUrl(next))
                }}
              />
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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

function DayItem({
  row,
  isActive,
  isExpanded,
  subChildren,
  childrenByParent,
  activeSlug,
  onJump,
  onToggle,
  onSelectChild,
  onAddChild,
  onArchive,
}: {
  row: Row
  isActive: boolean
  isExpanded: boolean
  subChildren: KnownDoc[]
  childrenByParent: Map<string, KnownDoc[]>
  activeSlug: string | null
  onJump: () => void
  onToggle: () => void
  onSelectChild: (slug: string) => void
  onAddChild: (parentSlug: string) => void
  onArchive: (slug: string) => void
}) {
  const hasChildren = subChildren.length > 0
  const isEmpty = !row.hasEntry && !row.isToday

  // Today wins over selection — both share the accent palette but
  // today is solid and selection is 60% so the "anchor of the strip"
  // reads stronger than a passing selection. Empty days dim the
  // foreground without touching the background so the gap reads as
  // absence, not as a different state.
  const stateClass = row.isToday
    ? 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
    : isActive
      ? 'bg-sidebar-accent/60 text-sidebar-accent-foreground'
      : isEmpty
        ? 'text-sidebar-foreground/40 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/70'
        : 'text-sidebar-foreground/60'

  const labelContent = (
    <>
      <span className="truncate">{row.label}</span>
      <span
        className={cn(
          'ml-auto shrink-0 text-xs tabular-nums',
          row.isToday || isActive ? 'opacity-80' : 'opacity-60',
        )}
      >
        {hasChildren ? `${row.childCount} · ${row.weekday}` : row.weekday}
      </span>
    </>
  )

  if (!hasChildren) {
    return (
      <li>
        <TreeRow className={stateClass}>
          <TreeRowLead asChild>
            <span aria-hidden>
              <IconCalendar size={16} stroke={1.75} />
            </span>
          </TreeRowLead>
          <TreeRowLabel onClick={onJump}>{labelContent}</TreeRowLabel>
        </TreeRow>
      </li>
    )
  }

  return (
    <Collapsible
      asChild
      open={isExpanded}
      onOpenChange={(open) => {
        if (open !== isExpanded) onToggle()
      }}
    >
      <li>
        <TreeRow className={stateClass}>
          <CollapsibleTrigger asChild>
            <TreeRowLead
              aria-label={isExpanded ? 'Collapse day' : 'Expand day'}
              onClick={(e) => e.stopPropagation()}
            >
              <IconChevronRight
                size={16}
                stroke={1.75}
                className="transition-transform data-[state=open]:rotate-90"
              />
            </TreeRowLead>
          </CollapsibleTrigger>
          <TreeRowLabel onClick={onJump}>{labelContent}</TreeRowLabel>
        </TreeRow>
        <CollapsibleContent asChild>
          <TreeSub>
            {subChildren.map((child) => (
              <DocTreeNode
                key={child.slug}
                doc={child}
                childrenByParent={childrenByParent}
                activeSlug={activeSlug}
                onSelect={onSelectChild}
                onAddChild={onAddChild}
                onArchive={onArchive}
              />
            ))}
          </TreeSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

function addDays(dateISO: string, n: number): string {
  const d = new Date(dateISO)
  d.setDate(d.getDate() + n)
  return formatLocalDate(d)
}
