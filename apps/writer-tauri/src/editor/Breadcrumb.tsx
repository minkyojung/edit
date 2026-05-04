// Path strip above the editor title for tree-nested writing notes.
// Renders the chain of ancestors leading to the current doc; clicking
// any segment activates that ancestor in its own tab so the user can
// navigate the tree without going back to the sidebar.
//
// Hidden when there are no ancestors (root daily entries and any
// independent writing docs), so the editor stays uncluttered for the
// common case.

import { Fragment } from 'react'
import { useDocAncestry, type AncestorEntry } from '@/hooks/useDocAncestry'
import { useDocsStore } from '@/state/docsStore'
import { useDocTitle } from '@/hooks/useDocTitle'
import { todayLocalDate, formatLocalDate } from '@/hooks/useDocMeta'
import { cn } from '@/lib/utils'

export function Breadcrumb({ slug }: { slug: string | null }) {
  const ancestors = useDocAncestry(slug)
  if (ancestors.length === 0) return null

  return (
    <nav
      aria-label="Document path"
      className="mb-3 flex items-center gap-1 text-xs text-muted-foreground"
    >
      {ancestors.map((entry, i) => (
        <Fragment key={entry.slug}>
          <BreadcrumbSegment entry={entry} />
          {i < ancestors.length - 1 && (
            <span aria-hidden className="text-muted-foreground/50">
              ›
            </span>
          )}
        </Fragment>
      ))}
      <span aria-hidden className="text-muted-foreground/50">
        ›
      </span>
    </nav>
  )
}

function BreadcrumbSegment({ entry }: { entry: AncestorEntry }) {
  const setActive = useDocsStore((s) => s.setActive)
  const openDaily = useDocsStore((s) => s.openDaily)
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const handle = useDocsStore((s) => s.handles[entry.slug])
  const { title } = useDocTitle(handle?.ydoc ?? null)

  const label = labelFor(entry, title)
  const onClick = () => {
    // For daily ancestors, use openDaily so it adds itself back to
    // openSlugs if the user previously closed that tab. Writing
    // ancestors are always nested under an open daily, so they
    // should already be reachable; setActive is sufficient.
    if (entry.meta.type === 'daily' && entry.meta.date) {
      openDaily(entry.meta.date).catch((err) =>
        console.error('[breadcrumb] openDaily failed', err),
      )
    } else if (openSlugs.includes(entry.slug)) {
      setActive(entry.slug)
    } else {
      // Writing ancestor that isn't currently in tabs — push it back
      // into openSlugs and activate. setActive guards on that, so we
      // need to add the slug first.
      useDocsStore.setState((s) =>
        s.openSlugs.includes(entry.slug)
          ? s
          : { openSlugs: [...s.openSlugs, entry.slug] },
      )
      setActive(entry.slug)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'truncate rounded px-1 py-0.5 transition-colors',
        'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      {label}
    </button>
  )
}

/** Daily ancestors get the same relative label the sidebar uses
 * ("Today" / "Yesterday" / "Mon 28") so the path reads as time
 * context. Writing ancestors fall back to their title or "Untitled". */
function labelFor(entry: AncestorEntry, title: string): string {
  if (entry.meta.type === 'daily' && entry.meta.date) {
    return relativeDailyLabel(entry.meta.date)
  }
  return title || 'Untitled'
}

function relativeDailyLabel(date: string): string {
  const today = todayLocalDate()
  if (date === today) return 'Today'
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

// Re-export to keep the formatter close to its caller; not used
// directly by the breadcrumb but useful for sibling layouts later.
export { formatLocalDate }
