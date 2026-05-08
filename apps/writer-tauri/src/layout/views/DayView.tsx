// Day tab — the daily entry for `dayAnchor` plus its child note tree.
// On launch dayAnchor is today (the capture surface), but the prev/next
// chevrons let the user step backward and forward without leaving Day
// view. Past days live in Week / Month tabs too; this gives the same
// surface for arbitrary days.
//
// The header is a single segmented pill: date label on the left, two
// chevrons on the right, all sharing the same row geometry. Clicking
// the label is the "I want to be here" gesture and creates the daily
// lazily if it doesn't exist; clicking a chevron is pure navigation
// and never creates — when the new anchor has a daily, the editor
// follows; when it doesn't, the sidebar shows an empty state.
//
// The right edge of the row aligns with the SidebarTrigger above (both
// sit at `pr-1` from the sidebar wall) so the entire vertical
// rhythm — header icon, chevrons, "+ New note" — lines up.
//
// ⌘T (handled globally in Sidebar.tsx) jumps back to today.

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, shiftDayAnchor } from '@/state/docsStore'
import { DocTreeNode, indexChildren } from '../DocTreeNode'

export function DayView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const setActive = useDocsStore((s) => s.setActive)
  const openDaily = useDocsStore((s) => s.openDaily)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const setDayAnchor = useDocsStore((s) => s.setDayAnchor)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const anchoredDaily = useMemo(
    () =>
      knownDocs.find(
        (d) => d.type === 'daily' && d.date === dayAnchor && !d.archivedAt,
      ),
    [knownDocs, dayAnchor],
  )

  // Build the parent → children index from live, non-wiki docs only.
  // DayView only renders the anchored daily's subtree, but indexChildren
  // walks the full graph once so DocTreeNode's recursive lookups stay
  // O(1) per level.
  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && !d.type.startsWith('wiki:')),
    [knownDocs],
  )
  const childrenByParent = useMemo(() => indexChildren(liveDocs), [liveDocs])
  const children = anchoredDaily
    ? childrenByParent.get(anchoredDaily.slug) ?? []
    : []

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  // Chevron click: shift the anchor and, if a daily already exists for
  // the new date, follow it in the editor. Never creates — that's the
  // label-click contract. When the new anchor has no daily the editor
  // stays on whatever was active and the tree below switches to an
  // empty state, signaling "this day is empty, click the date to start."
  const handleShift = (delta: number) => {
    const next = shiftDayAnchor(dayAnchor, delta)
    setDayAnchor(next)
    const found = knownDocs.find(
      (d) => d.type === 'daily' && d.date === next && !d.archivedAt,
    )
    if (found) {
      setActive(found.slug)
      ensureNotesRoute()
    }
  }

  const onLabelClick = async () => {
    if (anchoredDaily) {
      setActive(anchoredDaily.slug)
    } else {
      await openDaily(dayAnchor)
    }
    ensureNotesRoute()
  }

  const dateLabel = formatDayLabel(dayAnchor)
  const isAnchorActive = anchoredDaily?.slug === activeSlug

  return (
    <div>
      <div
        className={cn(
          'flex items-center rounded-md transition-colors',
          isAnchorActive
            ? 'bg-accent text-foreground'
            : anchoredDaily
              ? 'text-foreground'
              : 'text-muted-foreground/70',
        )}
      >
        <button
          type="button"
          onClick={onLabelClick}
          className={cn(
            'flex min-w-0 flex-1 items-center px-2 py-1.5 text-left text-[13px] font-medium rounded-l-md',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            !isAnchorActive && 'hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <span className="truncate">{dateLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => handleShift(-1)}
          aria-label="Previous day"
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center',
            'text-muted-foreground/70 hover:text-foreground',
            !isAnchorActive && 'hover:bg-accent/50',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconChevronLeft size={14} stroke={1.75} />
        </button>
        <button
          type="button"
          onClick={() => handleShift(1)}
          aria-label="Next day"
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-r-md',
            'text-muted-foreground/70 hover:text-foreground',
            !isAnchorActive && 'hover:bg-accent/50',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconChevronRight size={14} stroke={1.75} />
        </button>
      </div>

      {anchoredDaily && children.length > 0 && (
        <ul className="ml-2 flex flex-col gap-0.5 border-l border-border pt-0.5 pl-1.5">
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
              onArchive={(slug) => archiveDoc(slug)}
            />
          ))}
        </ul>
      )}

      {anchoredDaily ? (
        <button
          type="button"
          onClick={async () => {
            await createChildNote(anchoredDaily.slug)
            ensureNotesRoute()
          }}
          className={cn(
            'mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px]',
            'text-muted-foreground/70 transition-colors hover:bg-accent/40 hover:text-foreground',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconPlus size={12} stroke={2} />
          <span>New note</span>
        </button>
      ) : (
        <div className="mt-1 px-2 py-1.5 text-[12px] text-muted-foreground/60">
          No entry for this day
        </div>
      )}
    </div>
  )
}

/** "Friday, May 8" — full weekday + short month so the header reads
 * as a sentence, not a code. The year is implied. */
function formatDayLabel(date: string): string {
  const d = new Date(date)
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}
