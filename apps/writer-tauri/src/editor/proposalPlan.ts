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

import { ChangeSet, Text } from '@codemirror/state'
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

  // Two coordinate moves, both delegated to CodeMirror rather than open-coded.
  // `unstrip` is the inverse of removing the existing greens, so it maps CLEAN
  // positions onto the REAL document; `insert` then carries those through this
  // batch's own insertions. `mapPos` takes the association as an argument, which is
  // the whole point: a position sitting exactly on an insertion is ambiguous, and the
  // two bugs this replaced both came from resolving that ambiguity by hand — once in
  // the clean→real step (a second proposal's red began at the first one's green) and
  // once in the running `freshOffset` total.
  const sortedGreens = [...existingGreens].sort((a, b) => a.from - b.from)
  const strip = ChangeSet.of(
    sortedGreens.map((g) => ({ from: g.from, to: g.to })),
    realDoc.length,
  )
  const unstrip = strip.invert(Text.of(realDoc.split('\n')))

  // Pass 1 — red in PRE-insert real coordinates, plus the insertions themselves
  // (which CM applies as a set, so they stay in those coordinates).
  const staged = tagged.map(({ changeId, h }) => ({
    changeId,
    h,
    redFrom: unstrip.mapPos(h.from, 1), // a start begins past a green sitting there
    redTo: unstrip.mapPos(h.to, -1), // an end stops before it
  }))
  const insertions = staged
    .filter((s) => s.h.kind !== 'delete' && !!s.h.after)
    .map((s) => ({ from: s.redTo, insert: s.h.after! }))

  // Pass 2 — carry the red ranges through those insertions. Green is the text each
  // insertion put in, so it starts where its own red ends.
  const insert = ChangeSet.of(insertions, realDoc.length)
  const byChange = new Map<string, ProposalHunk[]>()
  for (const s of staged) {
    const redFrom = insert.mapPos(s.redFrom, 1)
    const redTo = insert.mapPos(s.redTo, -1)
    const green = s.h.kind !== 'delete' && s.h.after ? s.h.after.length : 0
    if (!byChange.has(s.changeId)) byChange.set(s.changeId, [])
    byChange.get(s.changeId)!.push({
      redFrom,
      redTo,
      greenFrom: redTo,
      greenTo: redTo + green,
      kind: s.h.kind,
    })
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
