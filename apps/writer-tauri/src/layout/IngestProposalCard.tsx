// Welcome card for the Karpathy "Memories" ingest pass — surfaces
// the queue of LLM-proposed wiki updates without interrupting the
// user's writing flow. Mounts in the sidebar footer above the
// archive button (Conductor-style update card).
//
// Visibility: only when there are pending proposals AND the user
// hasn't dismissed the current batch. Each fresh enqueue auto-clears
// dismiss, so a new batch always wakes the card even if the user
// closed an earlier one.
//
// Review action: navigates to the first target wiki page. The
// useApplyPendingMarks hook (mounted at App root) sees the active
// page change, materializes the queued proposals as proofSuggestion
// marks in that page's editor, and removes them from the queue. The
// user reviews via the existing MarkPopoverLayer (accept / reject
// inline), same affordance as AI suggestions in chat. Other targets
// stay queued — the card persists with a smaller count until the
// user navigates to those pages too.

import { useNavigate } from 'react-router-dom'
import { IconX } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'

/** Pull a short, readable noun phrase out of a proposal's markdown
 * body so the card preview reads as "Sarah, project deadline" rather
 * than dumping the raw bullet line. Best-effort: strip leading
 * bullet, cut at the first em-dash / colon (which usually separates
 * the entity from its description), then clamp length. */
function extractTitle(content: string): string {
  const cleaned = content
    .replace(/^[-*•]\s*/, '')
    .split(/[—:]/)[0]
    .trim()
  return cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned
}

/** Compose the one-line preview shown in the card body. Variants:
 *   "1 update from daily/2026-05-07 — Sarah"
 *   "3 updates from 2 notes — Sarah, project, …"
 * Capped at two titles plus an ellipsis so the card never grows
 * past two lines of body text. */
function previewText(proposals: PendingProposal[]): string {
  if (proposals.length === 0) return ''
  const sources = new Set(proposals.map((p) => p.sourceSlug))
  const sourceLabel =
    sources.size === 1
      ? `from ${proposals[0].sourceLabel}`
      : `from ${sources.size} notes`
  const titles = proposals.slice(0, 2).map((p) => extractTitle(p.content))
  const titlesText = titles.join(', ') + (proposals.length > 2 ? ', …' : '')
  const noun = proposals.length === 1 ? 'update' : 'updates'
  return `${proposals.length} ${noun} ${sourceLabel} — ${titlesText}`
}

/** Pull a sample sourceQuote from the queue so the card hints at
 * provenance — "where in my note did this come from?". Single
 * proposal: that proposal's quote. Multiple: the first one with a
 * quote, capped to a readable length. Returns null when no
 * proposal carried a quote. */
function sourceQuotePreview(proposals: PendingProposal[]): string | null {
  const withQuote = proposals.find((p) => p.sourceQuote?.trim())
  const q = withQuote?.sourceQuote?.trim()
  if (!q) return null
  return q.length > 80 ? `${q.slice(0, 80)}…` : q
}

export function IngestProposalCard() {
  const proposals = useIngestStore((s) => s.pendingProposals)
  const dismissed = useIngestStore((s) => s.dismissed)
  const dismiss = useIngestStore((s) => s.dismiss)
  const setActive = useDocsStore((s) => s.setActive)
  const navigate = useNavigate()

  if (proposals.length === 0 || dismissed) return null

  const onReview = () => {
    // Find the first target type that has a wiki page in the
    // catalog, then navigate to it. useApplyPendingMarks (App root)
    // takes over from there: when the editor mounts for that doc,
    // it stamps the queued proposals as marks. We don't materialize
    // here because the apply flow needs an EditorView, which only
    // exists once the doc is active and Milkdown has mounted.
    const docs = useDocsStore.getState().knownDocs
    for (const proposal of proposals) {
      const doc = docs.find(
        (d) => d.type === proposal.target && !d.archivedAt,
      )
      if (doc) {
        setActive(doc.slug)
        navigate('/notes')
        return
      }
    }
    // No matching wiki page in the catalog (proposal targets a doc
    // that was archived between ingest and review). Surface this
    // softly rather than silently no-oping; future polish can rerun
    // ingest or drop the orphan proposal.
    console.warn('[ingest] no live target for queued proposals')
  }

  return (
    <div
      className={cn(
        'relative rounded-lg border border-border bg-card/80 p-3 shadow-sm',
        'transition-shadow hover:shadow-md',
      )}
    >
      {/* Dismiss sits in the corner so the title can claim the
          full top of the card (no badge to share space with). */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          dismiss()
        }}
        aria-label="Dismiss"
        className={cn(
          'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded',
          'text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <IconX size={12} stroke={1.75} />
      </button>

      <button
        type="button"
        onClick={onReview}
        className={cn(
          'flex w-full flex-col items-start gap-1.5 pr-6 text-left',
          'outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <h4 className="text-sm font-medium text-foreground">
          Wiki updates ready
        </h4>
        <p className="text-[12px] leading-snug text-muted-foreground">
          {previewText(proposals)}
        </p>
        {sourceQuotePreview(proposals) && (
          <p className="border-l-2 border-border/60 pl-2 text-[11.5px] italic leading-snug text-muted-foreground/80">
            “{sourceQuotePreview(proposals)}”
          </p>
        )}
        <span
          className={cn(
            'mt-1 text-[12px] font-medium text-foreground/80',
            'transition-colors group-hover:text-foreground',
          )}
        >
          Review →
        </span>
      </button>
    </div>
  )
}
