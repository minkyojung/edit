// Path strip in the editor header. Renders the chain of ancestors
// leading to the current doc; clicking any segment activates that
// ancestor in its own tab so the user can navigate the tree without
// going back to the sidebar.
//
// Edge cases:
// - Active doc is a daily entry at the root (no ancestors): show its
//   own date label as a single segment, no trailing chevron — gives
//   the header context even at the top of the tree.
// - More than 3 ancestors: collapse the middle into a clickable […]
//   popover. First ancestor (root context) and last 2 (immediate
//   neighborhood) stay visible — Notion / Slack pattern.
// - Hidden entirely for non-daily root docs (independent writing
//   notes), where there's no useful context to show.

import { Fragment } from 'react'
import { IconDots } from '@tabler/icons-react'
import { useDocAncestry, type AncestorEntry } from '@/hooks/useDocAncestry'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const COLLAPSE_THRESHOLD = 4 // collapse when ancestors length >= this

export function Breadcrumb({ slug }: { slug: string | null }) {
  const ancestors = useDocAncestry(slug)
  const current = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) ?? null : null,
  )

  // Daily-at-root: no ancestors but the active doc itself is a daily
  // entry. Show the date as the only segment — preserves a sense of
  // place even at the top of the hierarchy.
  if (ancestors.length === 0) {
    if (current?.type === 'daily' && current.date) {
      return (
        <nav
          aria-label="Document path"
          className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted-foreground"
        >
          <BreadcrumbSegment entry={{ slug: current.slug, meta: current }} />
        </nav>
      )
    }
    return null
  }

  const collapsed = ancestors.length >= COLLAPSE_THRESHOLD
  // first + last 2 visible; everything between goes into the [...] popover.
  const head = collapsed ? ancestors[0] : null
  const tail = collapsed ? ancestors.slice(-2) : ancestors
  const hidden = collapsed ? ancestors.slice(1, -2) : []

  return (
    <nav
      aria-label="Document path"
      className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted-foreground"
    >
      {head && (
        <Fragment>
          <BreadcrumbSegment entry={head} />
          <Separator />
          <CollapsedSegments hidden={hidden} />
          <Separator />
        </Fragment>
      )}
      {tail.map((entry, i) => (
        <Fragment key={entry.slug}>
          <BreadcrumbSegment entry={entry} />
          {i < tail.length - 1 && <Separator />}
        </Fragment>
      ))}
      <Separator />
    </nav>
  )
}

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ›
    </span>
  )
}

function CollapsedSegments({ hidden }: { hidden: AncestorEntry[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${hidden.length} hidden ancestor${hidden.length === 1 ? '' : 's'}`}
          className={cn(
            'flex h-5 items-center rounded px-1 text-muted-foreground transition-colors',
            'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <IconDots size={14} stroke={1.75} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-56 p-1">
        <ul className="flex flex-col">
          {hidden.map((entry) => (
            <li key={entry.slug}>
              <CollapsedSegmentRow entry={entry} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function CollapsedSegmentRow({ entry }: { entry: AncestorEntry }) {
  const writingLabel = useDocLabel(entry.slug)
  const onActivate = useActivateAncestor(entry)
  const label = labelFor(entry.meta, writingLabel)
  return (
    <button
      type="button"
      onClick={onActivate}
      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className="truncate">{label}</span>
    </button>
  )
}

function BreadcrumbSegment({ entry }: { entry: AncestorEntry }) {
  const writingLabel = useDocLabel(entry.slug)
  const onActivate = useActivateAncestor(entry)
  const label = labelFor(entry.meta, writingLabel)

  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        'max-w-[140px] truncate rounded px-1 py-0.5 transition-colors',
        'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      {label}
    </button>
  )
}

/** Shared activation logic: dailies use openDaily so closed-tab
 * dailies reopen; writing ancestors are pushed back into openSlugs if
 * the user closed that tab. */
function useActivateAncestor(entry: AncestorEntry) {
  const setActive = useDocsStore((s) => s.setActive)
  const openDaily = useDocsStore((s) => s.openDaily)
  const openSlugs = useDocsStore((s) => s.openSlugs)
  return () => {
    if (entry.meta.type === 'daily' && entry.meta.date) {
      openDaily(entry.meta.date).catch((err) =>
        console.error('[breadcrumb] openDaily failed', err),
      )
      return
    }
    if (openSlugs.includes(entry.slug)) {
      setActive(entry.slug)
      return
    }
    useDocsStore.setState((s) =>
      s.openSlugs.includes(entry.slug)
        ? s
        : { openSlugs: [...s.openSlugs, entry.slug] },
    )
    setActive(entry.slug)
  }
}

/** Daily entries get an absolute date label ("May 4", "Dec 31, 2025")
 * — clearer than relative ("Today" / "Yesterday") for a path
 * indicator. Writing entries fall back to their title or "Untitled". */
function labelFor(meta: KnownDoc, title: string): string {
  if (meta.type === 'daily' && meta.date) {
    return absoluteDailyLabel(meta.date)
  }
  return title || 'Untitled'
}

function absoluteDailyLabel(date: string): string {
  const d = new Date(date)
  const t = new Date(todayLocalDate())
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}),
  })
}

// Re-export to keep the formatter close to its caller; not used
// directly by the breadcrumb but useful for sibling layouts later.
export { formatLocalDate }
