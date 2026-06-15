// Presentational card for one pending change, rendered inline in the
// chat answer. The diff and decision both read the single source of
// truth — `pendingChangesStore` — so Keep / Reject here stay in sync
// with the inline editor widget and the Review panel automatically.
//
// Mirrors the Review panel's PendingDetail (same DiffBlock, same
// `pending-edit__action` classes) so every pending-change surface looks
// and behaves identically.

import { useMemo, useState } from 'react'
import { Code2Icon, ChevronDownIcon } from 'lucide-react'
import type { PendingChange } from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import { cn } from '@/lib/utils'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { requestScrollToChange } from '@/state/activeCmEditor'

export function SuggestionCard({ change }: { change: PendingChange }) {
  const title = useDocsStore((s) => {
    const doc = s.knownDocs.find((d) => d.slug === change.pageSlug)
    return doc?.title?.trim() || doc?.type || change.pageSlug
  })

  const diffLines = useMemo(() => computePendingDiffLines(change), [change])
  // +N / -M line counts for the header, derived from the same diff the body renders.
  const { added, removed } = useMemo(() => {
    let added = 0
    let removed = 0
    for (const l of diffLines) {
      if (l.kind === 'add') added += 1
      else if (l.kind === 'remove') removed += 1
    }
    return { added, removed }
  }, [diffLines])
  const isPending = change.status === 'pending'
  const [open, setOpen] = useState(true)

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-background text-xs">
      {/* Header: a flush block. The title area is its own clickable jump target with a
          hover state; the chevron toggles the body separately. */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => {
            navigateToNoteBySlug(change.pageSlug)
            requestScrollToChange(change.pageSlug, change.id)
          }}
          title="Jump to this change in the note"
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60"
        >
          <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{title}</span>
          {(added > 0 || removed > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
              {added > 0 && <span className="text-green-700 dark:text-green-600">+{added}</span>}
              {removed > 0 && <span className="text-red-700 dark:text-red-600">-{removed}</span>}
            </span>
          )}
          {!isPending && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {change.status === 'accepted' ? 'Kept' : 'Rejected'}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse diff' : 'Expand diff'}
          className="shrink-0 px-2 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn('size-3.5 transition-transform', !open && '-rotate-90')}
          />
        </button>
      </div>

      {open && diffLines.length > 0 && (
        <div className="border-t border-border/60">
          <DiffBlock lines={diffLines} bare />
        </div>
      )}
    </div>
  )
}
