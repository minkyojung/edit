// Presentational card for one pending change, rendered inline in the
// chat answer. The diff and decision both read the single source of
// truth — `pendingChangesStore` — so Keep / Reject here stay in sync
// with the inline editor widget and the Review panel automatically.
//
// Mirrors the Review panel's PendingDetail (same DiffBlock, same
// `pending-edit__action` classes) so every pending-change surface looks
// and behaves identically.

import { useMemo } from 'react'
import {
  usePendingChangesStore,
  rejectPendingChange,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'

export function SuggestionCard({ change }: { change: PendingChange }) {
  const accept = usePendingChangesStore((s) => s.accept)
  const title = useDocsStore((s) => {
    const doc = s.knownDocs.find((d) => d.slug === change.pageSlug)
    return doc?.title?.trim() || doc?.type || change.pageSlug
  })

  const diffLines = useMemo(() => computePendingDiffLines(change), [change])
  const isPending = change.status === 'pending'

  return (
    <div className="my-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="truncate font-medium text-foreground">{title}</span>
        {!isPending && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {change.status === 'accepted' ? 'Kept' : 'Rejected'}
          </span>
        )}
      </div>

      {diffLines.length > 0 && <DiffBlock lines={diffLines} />}

      {change.context.rationale && (
        <div className="mt-1.5 text-muted-foreground">
          <span className="font-medium">Requested: </span>
          {change.context.rationale}
        </div>
      )}

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
