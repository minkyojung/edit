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
import {
  usePendingChangesStore,
  rejectPendingChange,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import { cn } from '@/lib/utils'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { requestScrollToChange } from '@/state/activeCmEditor'

export function SuggestionCard({ change }: { change: PendingChange }) {
  const accept = usePendingChangesStore((s) => s.accept)
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
      else removed += 1
    }
    return { added, removed }
  }, [diffLines])
  const isPending = change.status === 'pending'
  const [open, setOpen] = useState(true)

  return (
    <div className="my-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
      <div className={cn('flex items-center gap-2', open && 'mb-1.5')}>
        <button
          type="button"
          onClick={() => {
            navigateToNoteBySlug(change.pageSlug)
            requestScrollToChange(change.pageSlug, change.id)
          }}
          title="Jump to this change in the note"
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:opacity-80"
        >
          <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{title}</span>
          {(added > 0 || removed > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
              {added > 0 && <span className="text-green-600 dark:text-green-400">+{added}</span>}
              {removed > 0 && <span className="text-destructive">-{removed}</span>}
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
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn('size-3.5 transition-transform', !open && '-rotate-90')}
          />
        </button>
      </div>

      {open && diffLines.length > 0 && <DiffBlock lines={diffLines} />}

      {isPending && (
        <div className="pending-edit__actions mt-2">
          <button
            type="button"
            className="pending-edit__action pending-edit__action--reject"
            onClick={() => rejectPendingChange(change.id)}
          >
            Reject
          </button>
          <button
            type="button"
            className="pending-edit__action pending-edit__action--keep"
            onClick={() => accept(change.id)}
          >
            Keep
          </button>
        </div>
      )}
    </div>
  )
}
