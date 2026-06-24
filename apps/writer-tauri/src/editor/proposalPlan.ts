// Pure planning for the in-buffer (Cursor-style) review — Option B, step 2a.
// No CodeMirror / DOM: given the CLEAN doc text and the pending changes, work out
//   1. the insertions that drop each proposal's NEW text into the buffer as REAL
//      text (so editing it is fully native), and
//   2. the resulting red (old, struck) + green (new, editable) ranges.
// The reconciler (next step) just applies `insertions` and stores `mats`.
//
// Key invariant (tested): removing the green ranges from the inserted doc returns
// the ORIGINAL clean doc exactly — that's what we SAVE while pending, so disk only
// ever holds accepted text.

import { computeCmHunks } from './cmHunks'
import type { PendingChange } from '@/state/pendingChangesStore'

export type ProposalHunk = {
  redFrom: number
  redTo: number
  greenFrom: number
  greenTo: number
  kind: 'replace' | 'delete' | 'add'
}
export type ProposalMat = { changeId: string; hunks: ProposalHunk[] }

export type ProposalPlan = {
  /** Insertions to apply to the clean doc (clean-doc coordinates). */
  insertions: { from: number; insert: string }[]
  /** Resulting per-change ranges, in POST-insertion (real-doc) coordinates. */
  mats: ProposalMat[]
}

export function planProposals(cleanDoc: string, changes: PendingChange[]): ProposalPlan {
  // Every hunk across all changes, tagged with its change id, sorted by position
  // so the offset walk stays monotonic. computeCmHunks already line-diffs each
  // change against the clean doc, so `after` carries its own line breaks.
  const tagged = changes
    .flatMap((c) => computeCmHunks(cleanDoc, c).map((h) => ({ changeId: c.id, h })))
    .sort((a, b) => a.h.from - b.h.from)

  const insertions: { from: number; insert: string }[] = []
  const byChange = new Map<string, ProposalHunk[]>()
  let offset = 0
  for (const { changeId, h } of tagged) {
    const redFrom = h.from + offset
    const redTo = h.to + offset
    let greenFrom = redTo
    let greenTo = redTo
    if (h.kind !== 'delete' && h.after) {
      // Drop the proposal text right after the (struck) red. The hunks are
      // line-level, so `after` already starts/ends on line boundaries — no extra
      // separators, which keeps the strip-green round-trip exact.
      insertions.push({ from: h.to, insert: h.after }) // clean-doc coordinate
      greenFrom = redTo
      greenTo = redTo + h.after.length
      offset += h.after.length
    }
    if (!byChange.has(changeId)) byChange.set(changeId, [])
    byChange.get(changeId)!.push({ redFrom, redTo, greenFrom, greenTo, kind: h.kind })
  }
  return { insertions, mats: [...byChange.entries()].map(([changeId, hunks]) => ({ changeId, hunks })) }
}

export function greenRangesOf(mats: ProposalMat[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const m of mats) for (const h of m.hunks) if (h.greenTo > h.greenFrom) out.push({ from: h.greenFrom, to: h.greenTo })
  return out
}

export function redRangesOf(mats: ProposalMat[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const m of mats) for (const h of m.hunks) if (h.redTo > h.redFrom) out.push({ from: h.redFrom, to: h.redTo })
  return out
}

/** The text to SAVE while proposals are pending: the doc with the green
 * (proposal) ranges removed = the accepted-so-far state. */
export function stripRanges(docText: string, ranges: { from: number; to: number }[]): string {
  let text = docText
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, r.from) + text.slice(r.to)
  }
  return text
}
