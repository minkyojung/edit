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

/** Map a position in the CLEAN doc (the real doc with `greens` removed) back to
 * the REAL doc — shift it past every existing green run that precedes it. The
 * inverse of stripRanges' coordinate effect.
 *
 * A clean position that lands exactly ON a green's insertion point is AMBIGUOUS:
 * the green occupies no clean-space width, so "just before it" and "just after it"
 * are the same clean number but different real ones. `assoc` picks, the same way
 * CodeMirror's `mapPos` does:
 *   • 'before' (default) — a range END stops short of the green.
 *   • 'after'            — a range START begins past it.
 * Defaulting both to 'before' let a second proposal's red start at the FIRST
 * proposal's green: its red span then covered the earlier proposal's text, so
 * accepting the second one deleted the first one's suggestion along with it. */
export function cleanToReal(
  cleanPos: number,
  greens: { from: number; to: number }[],
  assoc: 'before' | 'after' = 'before',
): number {
  let real = 0
  let clean = 0
  for (const g of [...greens].sort((a, b) => a.from - b.from)) {
    const seg = g.from - real // non-green run before this green
    const boundary = clean + seg
    if (cleanPos < boundary || (cleanPos === boundary && assoc === 'before')) {
      return real + (cleanPos - clean)
    }
    clean += seg
    real = g.to
  }
  return real + (cleanPos - clean)
}

/** Plan fresh proposals to sit ALONGSIDE already-materialized ones. `existingGreens`
 * are the green ranges already in `realDoc`; we plan against the clean doc (real
 * minus those) and translate every position back into real coordinates (past the
 * existing green, and past the fresh green inserted earlier in this batch). Returns
 * insertions in ORIGINAL real coords (CM applies them as a set) and mats in the
 * POST-insert real coords. With no existing green (`existingGreens: []`) this is
 * the plain "materialize a fresh batch into a clean doc" case. */
export function planAdditional(
  realDoc: string,
  existingGreens: { from: number; to: number }[],
  changes: PendingChange[],
): ProposalPlan {
  const cleanDoc = stripRanges(realDoc, existingGreens)
  const tagged = changes
    .flatMap((c) => computeCmHunks(cleanDoc, c).map((h) => ({ changeId: c.id, h })))
    .sort((a, b) => a.h.from - b.h.from)

  const insertions: { from: number; insert: string }[] = []
  const byChange = new Map<string, ProposalHunk[]>()
  let freshOffset = 0 // fresh green inserted earlier in this batch (shifts later real positions)
  for (const { changeId, h } of tagged) {
    // A red START must begin past an existing green sitting at that point; a red END
    // must stop before one. See cleanToReal.
    const redFrom = cleanToReal(h.from, existingGreens, 'after') + freshOffset
    const redTo = cleanToReal(h.to, existingGreens, 'before') + freshOffset
    let greenFrom = redTo
    let greenTo = redTo
    if (h.kind !== 'delete' && h.after) {
      insertions.push({ from: cleanToReal(h.to, existingGreens), insert: h.after }) // original real coord
      greenFrom = redTo
      greenTo = redTo + h.after.length
      freshOffset += h.after.length
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
