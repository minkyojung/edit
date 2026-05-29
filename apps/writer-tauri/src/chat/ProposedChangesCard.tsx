// Interactive tray of the current chat run's staged edits, docked just
// above the prompt input. Each still-pending chat-source change renders
// as a compact card: the affected page (click to navigate), a git-style
// diff, and Keep / Reject.
//
// Why interactive here (Step 1 of chat-native suggestions): every
// surface — Review panel, inline editor widget, this card — subscribes
// to the SAME `pendingChangesStore`, and Keep/Reject are just
// `store.accept(id)` / `store.reject(id)`. So a decision made here
// updates the inline widget and Review panel instantly, and vice versa,
// with no second source of truth to drift. This replaces the earlier
// read-only chip list: the user can now review and decide without
// leaving the chat. (Click-the-page navigation is kept as a secondary
// affordance for users who prefer deciding on the page.)
//
// The tray reads every still-pending chat-source change across runs.
// Multi-turn conversations can stack pending changes (the user might
// defer a decision from a previous turn and run another); each
// unresolved change is actionable, so we list them all. As the user
// decides, accepted/rejected entries drop out of the `pending` filter
// and their cards unmount; once everything is decided the tray empties
// and renders nothing.

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  usePendingChangesStore,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import { buildDayUrl } from '@/lib/viewUrl'
import { todayLocalDate } from '@/hooks/useDocMeta'

export function ProposedChangesCard() {
  const byId = usePendingChangesStore((s) => s.byId)
  const knownDocs = useDocsStore((s) => s.knownDocs)

  // One card per pending chat change, oldest first so the order matches
  // the sequence the user asked for them in.
  const changes = useMemo(
    () =>
      Object.values(byId)
        .filter((c) => c.source === 'chat' && c.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt),
    [byId],
  )

  if (changes.length === 0) return null

  return (
    <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
      {changes.map((change) => (
        <SuggestionCard key={change.id} change={change} knownDocs={knownDocs} />
      ))}
    </div>
  )
}

/** A single pending change rendered as diff + decision row. Mirrors the
 * Review panel's PendingDetail (same diff renderer, same Keep/Reject
 * classes) so the two surfaces look and behave identically. */
function SuggestionCard({
  change,
  knownDocs,
}: {
  change: PendingChange
  knownDocs: KnownDoc[]
}) {
  const accept = usePendingChangesStore((s) => s.accept)
  const reject = usePendingChangesStore((s) => s.reject)
  const navigate = useNavigate()

  const diffLines = useMemo(() => computePendingDiffLines(change), [change])
  const doc = knownDocs.find((d) => d.slug === change.pageSlug)
  const title = doc?.title?.trim() || doc?.type || change.pageSlug

  return (
    <div className="rounded-md border border-border bg-muted/40 p-2 text-xs">
      <button
        type="button"
        onClick={() => navigate(urlForSlug(change.pageSlug, knownDocs))}
        className="mb-1.5 block max-w-full truncate text-left font-medium text-foreground hover:underline"
        title={`Open ${title}`}
      >
        {title}
      </button>

      {diffLines.length > 0 && <DiffBlock lines={diffLines} />}

      {change.context.rationale && (
        <div className="mt-1.5 text-muted-foreground">
          <span className="font-medium">Requested: </span>
          {change.context.rationale}
        </div>
      )}

      <div className="pending-edit__actions mt-2">
        <button
          type="button"
          className="pending-edit__action pending-edit__action--reject"
          onClick={() => reject(change.id)}
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
    </div>
  )
}

/** Resolve a slug to its canonical URL. Wiki / system / writing docs all
 * live under day view by default — the active doc switches via the slug
 * in the path; the day anchor is just a context the URL needs.
 * RouteSyncBridge handles the rest. */
function urlForSlug(slug: string, knownDocs: KnownDoc[]): string {
  const doc = knownDocs.find((d) => d.slug === slug)
  if (doc?.type === 'daily' && doc.date) return buildDayUrl(doc.date, slug)
  return buildDayUrl(todayLocalDate(), slug)
}
