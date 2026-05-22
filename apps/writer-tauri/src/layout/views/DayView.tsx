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
import { useNavigate } from 'react-router-dom'
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, shiftDayAnchor, isWikiDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildDayUrl } from '@/lib/viewUrl'
import { DocTreeNode, indexChildren } from '../DocTreeNode'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'

export function DayView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useActiveSlug()
  const openDaily = useDocsStore((s) => s.openDaily)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const navigate = useNavigate()

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
    () => knownDocs.filter((d) => !d.archivedAt && !isWikiDoc(d)),
    [knownDocs],
  )
  const childrenByParent = useMemo(() => indexChildren(liveDocs), [liveDocs])
  const children = anchoredDaily
    ? childrenByParent.get(anchoredDaily.slug) ?? []
    : []

  // Chevron click: shift the anchor and, if a daily already exists for
  // the new date, follow it in the editor. Never creates — that's the
  // label-click contract. When the new anchor has no daily the editor
  // stays on whatever was active and the tree below switches to an
  // empty state, signaling "this day is empty, click the date to start."
  // navigate() drives the store via useRouteSync; whichever slug ends
  // up in the URL becomes the active doc on the next tick.
  const handleShift = (delta: number) => {
    const next = shiftDayAnchor(dayAnchor, delta)
    const found = knownDocs.find(
      (d) => d.type === 'daily' && d.date === next && !d.archivedAt,
    )
    const targetSlug = found?.slug ?? activeSlug
    navigate(buildDayUrl(next, targetSlug))
  }

  const onLabelClick = async () => {
    if (anchoredDaily) {
      navigate(buildDayUrl(dayAnchor, anchoredDaily.slug))
    } else {
      const created = await openDaily(dayAnchor)
      navigate(buildDayUrl(dayAnchor, created ?? activeSlug))
    }
  }

  const dateLabel = formatDayLabel(dayAnchor)

  return (
    <SidebarGroup className="p-0">
      <div
        className={cn(
          'group mx-2 flex items-center gap-0.5 rounded-xl pr-1 transition-colors',
          anchoredDaily
            ? 'text-sidebar-foreground hover:bg-sidebar-accent/50'
            : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
        )}
        style={{ height: 'var(--header-h)' }}
      >
        <SidebarGroupLabel
          asChild
          className="flex-1 min-w-0 h-full px-2 rounded-none text-sm font-medium text-current"
        >
          <button type="button" onClick={onLabelClick} className="text-left">
            <span className="truncate">{dateLabel}</span>
          </button>
        </SidebarGroupLabel>
        {/* Day navigators sized down to icon-xs (24px) so the header
            stays compact. Color tokens overridden to sidebar palette
            since the default ghost variant uses generic `muted`. */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => handleShift(-1)}
          aria-label="Previous day"
          className="rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
        >
          <IconChevronLeft stroke={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => handleShift(1)}
          aria-label="Next day"
          className="rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
        >
          <IconChevronRight stroke={1.75} />
        </Button>
      </div>

      <SidebarGroupContent className="px-2">
        {anchoredDaily && children.length > 0 && (
          <SidebarMenu className="pt-0.5">
            {children.map((child) => (
              <DocTreeNode
                key={child.slug}
                doc={child}
                childrenByParent={childrenByParent}
                activeSlug={activeSlug}
                onSelect={(slug) => navigate(buildDayUrl(dayAnchor, slug))}
                onAddChild={async (parentSlug) => {
                  const created = await createChildNote(parentSlug)
                  if (created) navigate(buildDayUrl(dayAnchor, created))
                }}
                onArchive={(slug) => {
                  const next = archiveDoc(slug)
                  if (next) navigate(buildDayUrl(dayAnchor, next))
                }}
              />
            ))}
          </SidebarMenu>
        )}

        {anchoredDaily ? (
          <SidebarMenu className="mt-1">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                onClick={async () => {
                  const created = await createChildNote(anchoredDaily.slug)
                  if (created) navigate(buildDayUrl(dayAnchor, created))
                }}
                className="text-[12px] text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
              >
                <IconPlus />
                <span>New note</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <div className="mt-1 px-2 py-1.5 text-[12px] text-sidebar-foreground/50">
            No entry for this day
          </div>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
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
