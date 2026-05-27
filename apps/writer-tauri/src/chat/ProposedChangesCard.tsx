// Compact card that lists pages affected by the current chat run's
// staged edits. Replaces PendingEditsBar (Phase E5) — instead of
// inlining the diff + Accept/Reject buttons in the chat panel, this
// card just names the affected pages as clickable chips. The user
// clicks one, navigates to the page, and decides via the inline
// review widget there.
//
// Why: PendingEditsBar duplicated the inline widget's decision UX,
// which meant two stores tracking the same change and the two
// surfaces drifting whenever one updated without the other. Cursor /
// Notion AI converged on "decision happens in the file, the chat
// summarises". This card is the summary half.
//
// The card reads `pendingChatForRun(runId)` so it only shows the
// changes that THIS run produced — not the entire app's pending
// queue. As the user makes decisions inline, the queue shrinks and
// the card's chip list collapses accordingly; once everything is
// decided, the card unmounts (caller passes a non-empty list only).

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { buildDayUrl, buildWeekUrl, buildMonthUrl } from '@/lib/viewUrl'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { cn } from '@/lib/utils'

/** No props — the card reads every still-pending chat-source change
 * across runs. Multi-turn conversations can stack pending changes
 * (the user might defer a decision from a previous turn and run
 * another); each unresolved change is actionable, so we list them
 * all. As the user makes decisions inline, the queue shrinks and
 * the card collapses. */
export function ProposedChangesCard() {
  const byId = usePendingChangesStore((s) => s.byId)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const navigate = useNavigate()

  // Dedupe by pageSlug — one turn can produce multiple edits for
  // the same file (MultiEdit, several Edits in sequence); a single
  // chip per file is enough to navigate the user there.
  const chips = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ slug: string; title: string }> = []
    const slugToDoc = new Map<string, KnownDoc>()
    for (const d of knownDocs) slugToDoc.set(d.slug, d)
    for (const c of Object.values(byId)) {
      if (c.source !== 'chat') continue
      if (c.status !== 'pending') continue
      if (seen.has(c.pageSlug)) continue
      seen.add(c.pageSlug)
      const doc = slugToDoc.get(c.pageSlug)
      out.push({
        slug: c.pageSlug,
        title: doc?.title?.trim() || doc?.type || c.pageSlug,
      })
    }
    return out
  }, [byId, knownDocs])

  if (chips.length === 0) return null

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-muted/40 px-3 py-2 text-xs',
      )}
    >
      <div className="mb-1.5 text-muted-foreground">
        Proposed changes — click a page to review:
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.slug}
            type="button"
            onClick={() => navigate(urlForSlug(chip.slug, knownDocs))}
            className={cn(
              'rounded-full border border-border bg-background px-2.5 py-0.5',
              'text-xs font-medium text-foreground hover:bg-muted',
              'transition-colors',
            )}
          >
            {chip.title}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Resolve a slug to its canonical URL. Mirrors the route shapes the
 * app already uses — day/week/month variants. For wiki / system docs
 * (no anchor) we default to the day view of today since the URL needs
 * an anchor. RouteSyncBridge handles the rest. */
function urlForSlug(slug: string, knownDocs: KnownDoc[]): string {
  const doc = knownDocs.find((d) => d.slug === slug)
  if (!doc) return buildDayUrl(todayLocalDate(), slug)
  if (doc.type === 'daily' && doc.date) return buildDayUrl(doc.date, slug)
  // Wiki / system / writing all live under day view by default — the
  // active doc switches via the slug in the path; the day anchor is
  // just a context the URL needs.
  if (doc.type === 'writing') {
    // writing's parent is a daily — use today as the anchor for the
    // simplest stable URL; route bridge will resolve if needed.
    return buildDayUrl(todayLocalDate(), slug)
  }
  // Headers other than day-anchored: week / month aren't paired with
  // wiki / system in this app's nav, so day-of-today is the canonical
  // fallback. (Same fallback the breadcrumb already uses.)
  void buildWeekUrl
  void buildMonthUrl
  return buildDayUrl(todayLocalDate(), slug)
}
