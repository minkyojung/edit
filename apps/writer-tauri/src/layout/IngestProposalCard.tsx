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
// PR 3-2 step 3 of 5: card only — clicking Review currently logs
// to the console. The next step swaps the console hook for a real
// review modal that can apply / skip individual proposals.

import { useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
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

export function IngestProposalCard() {
  const proposals = useIngestStore((s) => s.pendingProposals)
  const dismissed = useIngestStore((s) => s.dismissed)
  const dismiss = useIngestStore((s) => s.dismiss)
  // Local-only modal toggle. The review modal lives in the next PR
  // step; for now Review just logs the queue so we can verify the
  // wiring end-to-end without blocking on the modal UI.
  const [reviewOpen, setReviewOpen] = useState(false)

  if (proposals.length === 0 || dismissed) return null

  const onReview = () => {
    setReviewOpen(true)
    // Stub for PR 3-2 step 4 — surfaces the queue so a tester can
    // confirm the card-to-data pipeline before the modal exists.
    console.info('[ingest] review requested', {
      proposals,
      pendingLogs: useIngestStore.getState().pendingLogs,
    })
  }

  return (
    <div
      className={cn(
        'relative mx-2 mb-2 rounded-lg border border-border bg-card/80 p-3 shadow-sm',
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
        <h4 className="text-[13px] font-medium text-foreground">
          Wiki updates ready
        </h4>
        <p className="text-[12px] leading-snug text-muted-foreground">
          {previewText(proposals)}
        </p>
        <span
          className={cn(
            'mt-1 text-[12px] font-medium text-foreground/80',
            'transition-colors group-hover:text-foreground',
          )}
        >
          Review →
        </span>
      </button>

      {/* Modal placeholder — wired in PR 3-2 step 4. Keeping the
          state hook here lets that step plug a component in without
          touching the card again. */}
      {reviewOpen && null}
    </div>
  )
}
