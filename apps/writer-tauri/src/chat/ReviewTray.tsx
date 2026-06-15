// Docked review tray above the chat input. Aggregates EVERY pending change from
// pendingChangesStore, grouped by file (note). Collapsed by default: a one-line
// summary + bulk Keep/Reject. Expanded: one row per file with its own Keep/Reject
// and click-to-jump. Only Keep/Reject — our staged model (nothing hits disk until
// Keep) needs neither Undo nor a separate Review action.
//
// Store is the single source of truth; this only READS it. Decisions loop
// accept/reject over the relevant pending changes — no new store actions, and the
// inline chat cards + editor widgets stay in sync automatically.

import { useMemo, useState } from 'react'
import { Code2Icon, ChevronDownIcon } from 'lucide-react'
import {
  usePendingChangesStore,
  rejectPendingChange,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { requestScrollToChange } from '@/state/activeCmEditor'
import { cn } from '@/lib/utils'

interface FileGroup {
  slug: string
  title: string
  changes: PendingChange[]
  added: number
  removed: number
}

function countLines(changes: PendingChange[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const c of changes) {
    for (const l of computePendingDiffLines(c)) {
      if (l.kind === 'add') added += 1
      else if (l.kind === 'remove') removed += 1
    }
  }
  return { added, removed }
}

function Counts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
      {added > 0 && <span className="text-green-700 dark:text-green-600">+{added}</span>}
      {removed > 0 && <span className="text-red-700 dark:text-red-600">-{removed}</span>}
    </span>
  )
}

export function ReviewTray() {
  const byId = usePendingChangesStore((s) => s.byId)
  const accept = usePendingChangesStore((s) => s.accept)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const [open, setOpen] = useState(false)

  const groups = useMemo<FileGroup[]>(() => {
    const map = new Map<string, PendingChange[]>()
    for (const c of Object.values(byId)) {
      if (c.status !== 'pending') continue
      const arr = map.get(c.pageSlug) ?? []
      arr.push(c)
      map.set(c.pageSlug, arr)
    }
    return [...map.entries()].map(([slug, changes]) => {
      const doc = knownDocs.find((d) => d.slug === slug)
      return {
        slug,
        title: doc?.title?.trim() || doc?.type || slug,
        changes,
        ...countLines(changes),
      }
    })
  }, [byId, knownDocs])

  const total = useMemo(
    () => ({
      added: groups.reduce((n, g) => n + g.added, 0),
      removed: groups.reduce((n, g) => n + g.removed, 0),
    }),
    [groups],
  )

  if (groups.length === 0) return null

  const allPending = groups.flatMap((g) => g.changes)
  const keep = (changes: PendingChange[]) => changes.forEach((c) => accept(c.id))
  const reject = (changes: PendingChange[]) => changes.forEach((c) => rejectPendingChange(c.id))
  const jump = (g: FileGroup) => {
    // Only park a scroll request when navigation actually happened — a dead slug
    // (navigateToNoteBySlug → false) would otherwise leave a stale pending scroll.
    if (navigateToNoteBySlug(g.slug)) requestScrollToChange(g.slug, g.changes[0].id)
  }

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border bg-background text-xs">
      {/* Summary — collapsed view. Left toggles the file list; right is the bulk decision. */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60"
        >
          <ChevronDownIcon
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          />
          <span className="font-medium text-foreground">
            {groups.length} {groups.length === 1 ? 'file' : 'files'}
          </span>
          <Counts added={total.added} removed={total.removed} />
        </button>
        <div className="flex shrink-0 items-center gap-1 px-2">
          <button
            type="button"
            className="pending-edit__action pending-edit__action--reject"
            onClick={() => reject(allPending)}
          >
            Reject
          </button>
          <button
            type="button"
            className="pending-edit__action pending-edit__action--keep"
            onClick={() => keep(allPending)}
          >
            Keep
          </button>
        </div>
      </div>

      {/* Per-file rows — each jumps to the note and decides that file alone. */}
      {open && (
        <div className="border-t border-border/60">
          {groups.map((g) => (
            <div
              key={g.slug}
              className="flex items-stretch border-b border-border/40 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => jump(g)}
                title="Jump to this change in the note"
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/60"
              >
                <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground">{g.title}</span>
                <Counts added={g.added} removed={g.removed} />
              </button>
              <div className="flex shrink-0 items-center gap-1 px-2">
                <button
                  type="button"
                  className="pending-edit__action pending-edit__action--reject"
                  onClick={() => reject(g.changes)}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="pending-edit__action pending-edit__action--keep"
                  onClick={() => keep(g.changes)}
                >
                  Keep
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
