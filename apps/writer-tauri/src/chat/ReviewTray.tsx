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
import { Code2Icon, ChevronDownIcon, CheckIcon, XIcon } from 'lucide-react'
import {
  usePendingChangesStore,
  rejectPendingChange,
  type PendingChange,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import type { DiffLine } from '@/lib/git'
import { cn } from '@/lib/utils'

interface FileGroup {
  slug: string
  title: string
  changes: PendingChange[]
  added: number
  removed: number
  /** Combined diff lines for this file's pending changes — shown inline when the tray is
   * expanded so the user can review without jumping to the note. */
  diff: DiffLine[]
  /** True while the user hasn't opened this note since the change landed — the tray's
   * reason to exist: surfacing edits made while you weren't looking. Cleared by
   * markPageViewed when the note becomes active (App.tsx). */
  unviewed: boolean
}

/** Combined diff lines for a file's pending changes, plus +/- counts derived from the
 * same lines (so the header count and the inline preview never disagree). */
function diffForGroup(changes: PendingChange[]): { diff: DiffLine[]; added: number; removed: number } {
  const diff = changes.flatMap((c) => computePendingDiffLines(c))
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.kind === 'add') added += 1
    else if (l.kind === 'remove') removed += 1
  }
  return { diff, added, removed }
}

/** Small "unviewed" dot — a change the user hasn't opened the note for yet. Reserves
 * its slot even when off so row text doesn't shift as it appears/clears. */
function UnviewedDot({ on }: { on: boolean }) {
  return (
    <span className="flex size-1.5 shrink-0 items-center justify-center" aria-hidden>
      {on && <span className="size-1.5 rounded-full bg-info" />}
    </span>
  )
}

function Counts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
      {added > 0 && <span className="text-success">+{added}</span>}
      {removed > 0 && <span className="text-destructive">-{removed}</span>}
    </span>
  )
}

export function ReviewTray() {
  const byId = usePendingChangesStore((s) => s.byId)
  const accept = usePendingChangesStore((s) => s.accept)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const [open, setOpen] = useState(false)
  // Which file rows have their inline diff expanded — collapsed by default so the tray
  // stays a compact list; click a row to peek its diff.
  const [openSlugs, setOpenSlugs] = useState<Set<string>>(() => new Set())

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
        unviewed: changes.some((c) => c.viewedAt === null),
        ...diffForGroup(changes),
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
  const anyUnviewed = groups.some((g) => g.unviewed)
  const keep = (changes: PendingChange[]) => changes.forEach((c) => accept(c.id))
  const reject = (changes: PendingChange[]) => changes.forEach((c) => rejectPendingChange(c.id))
  const toggleFile = (slug: string) => {
    const willOpen = !openSlugs.has(slug)
    setOpenSlugs((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
    // Expanding a file's diff = the user reviewed it → clear its unviewed dot (same
    // markPageViewed used on navigation).
    if (willOpen) usePendingChangesStore.getState().markPageViewed(slug)
  }

  return (
    // Match the in-transcript suggestion-card width: the transcript content is inset by
    // `--surface-inset + 1rem` while this footer is only `--surface-inset`, so an extra
    // 1rem (mx-4) each side lines the tray up with the cards above. Flat bottom
    // (rounded-t-2xl) + no bottom margin so it sits flush on top of the composer.
    <div className="mx-4 overflow-hidden rounded-t-2xl border border-border bg-background text-xs">
      {/* Summary — collapsed view. Left toggles the file list; right is the bulk decision. */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
        >
          <ChevronDownIcon
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          />
          <UnviewedDot on={anyUnviewed} />
          <span className="font-medium text-foreground">
            {groups.length} {groups.length === 1 ? 'file' : 'files'}
          </span>
          <Counts added={total.added} removed={total.removed} />
        </button>
        <div className="flex shrink-0 items-center gap-1 px-2.5">
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

      {/* Per-file rows — header (jump + decide that file) over an inline diff preview.
          Height-capped so a big diff scrolls inside the tray instead of shoving the
          composer down. */}
      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t border-border/60">
          {groups.map((g) => {
            const expanded = openSlugs.has(g.slug)
            return (
              <div key={g.slug} className="border-b border-border/40 last:border-b-0">
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => toggleFile(g.slug)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                  >
                    <ChevronDownIcon
                      className={cn(
                        'size-3 shrink-0 text-muted-foreground transition-transform',
                        !expanded && '-rotate-90',
                      )}
                    />
                    <UnviewedDot on={g.unviewed} />
                    <Code2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-foreground">{g.title}</span>
                    <Counts added={g.added} removed={g.removed} />
                  </button>
                  {/* Per-file decisions as compact icons — visually distinct from the
                      bulk text buttons up top, so they don't read as a repeat. Right
                      padding (pr-4) lines the ✓ up with the bulk "Keep" text's right
                      edge: summary px-2.5 (10) + text-button pad (10) = 20; here pr-4
                      (16) + icon-button p-1 (4) = 20. */}
                  <div className="flex shrink-0 items-center gap-1 pl-2 pr-4">
                    <button
                      type="button"
                      aria-label="Reject"
                      onClick={() => reject(g.changes)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    >
                      <XIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Keep"
                      onClick={() => keep(g.changes)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-info"
                    >
                      <CheckIcon className="size-4" />
                    </button>
                  </div>
                </div>
                {expanded && g.diff.length > 0 && (
                  <div className="border-t border-border/40">
                    <DiffBlock lines={g.diff} bare />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
