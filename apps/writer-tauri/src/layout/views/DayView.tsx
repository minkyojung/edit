// Day tab — today's daily entry plus its child note tree. The
// capture surface: the user lands here on launch and works the
// current day. Past days live in Week / Month tabs.
//
// Today's daily is guaranteed to exist by docsStore.bootstrap, so
// the "missing today" branch only fires during the brief window
// before bootstrap resolves (or if the create round-trip fails).

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconPlus } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { DocTreeNode, indexChildren } from '../DocTreeNode'

export function DayView() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setActive = useDocsStore((s) => s.setActive)
  const createChildNote = useDocsStore((s) => s.createChildNote)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const today = todayLocalDate()
  const todayDaily = useMemo(
    () =>
      knownDocs.find(
        (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
      ),
    [knownDocs, today],
  )

  // Build the parent → children index from live, non-wiki docs only.
  // DayView only renders the today daily's subtree, but indexChildren
  // walks the full graph once so DocTreeNode's recursive lookups stay
  // O(1) per level.
  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && !d.type.startsWith('wiki:')),
    [knownDocs],
  )
  const childrenByParent = useMemo(() => indexChildren(liveDocs), [liveDocs])
  const children = todayDaily ? childrenByParent.get(todayDaily.slug) ?? [] : []

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  if (!todayDaily) {
    // Bootstrap is still creating today's daily, or it failed. Offer
    // a one-tap retry rather than silently spinning.
    return (
      <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/60">
        <button
          type="button"
          onClick={() => {
            openDaily(today).catch((err) =>
              console.error('[DayView] openDaily failed', err),
            )
            ensureNotesRoute()
          }}
          className="text-foreground underline-offset-2 hover:underline"
        >
          Open today's note
        </button>
      </div>
    )
  }

  const isTodayActive = todayDaily.slug === activeSlug
  const dateLabel = formatTodayLabel(today)

  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => {
          setActive(todayDaily.slug)
          ensureNotesRoute()
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isTodayActive
            ? 'bg-accent text-foreground'
            : 'text-foreground hover:bg-accent/50',
        )}
      >
        <span className="truncate">{dateLabel}</span>
      </button>

      {children.length > 0 && (
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

      <button
        type="button"
        onClick={async () => {
          await createChildNote(todayDaily.slug)
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
    </div>
  )
}

/** Today reads as "Tuesday, May 6" — full weekday + short month so
 * the header reads as a sentence, not a code. The year is implied
 * (it's today). */
function formatTodayLabel(date: string): string {
  const d = new Date(date)
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}
