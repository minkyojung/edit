// Compute the (snapshot → after) line diff and lift each hunk to a PM
// range using `BlockMap`. Output is consumed by the inline review
// plugin: 'remove' hunks become red strike-through marks on existing
// text; 'add' hunks become widget decorations rendered with the added
// markdown content.
//
// The pipeline:
//   1. diffLines(snapshot, after) — raw line-level changes
//   2. buildBlockMap(snapshot, pmDoc) — line → PM range lookup
//   3. fold the diff into PendingHunk[], collapsing consecutive lines
//      that fall inside the same block (so a 3-line paragraph removal
//      surfaces as ONE remove hunk, not three duplicates)
//
// Returns null when BlockMap construction fails — caller falls back to
// the prior whole-after-at-pos-0 widget.

import { diffLines } from 'diff'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { buildBlockMap } from './markdownBlockMap'

export type PendingHunk =
  | { type: 'remove'; pmFrom: number; pmTo: number }
  | { type: 'add'; pmAt: number; content: string }

export function computePendingHunks(
  snapshot: string,
  after: string,
  pmDoc: PMNode,
): PendingHunk[] | null {
  const blockMap = buildBlockMap(snapshot, pmDoc)
  if (!blockMap) return null

  const changes = diffLines(snapshot, after)
  const hunks: PendingHunk[] = []

  // 1-indexed cursor over snapshot lines. `lastAnchor` tracks the PM
  // position at which the NEXT 'add' hunk should land — set to the end
  // of the most recent unchanged block so additions tuck right after
  // the surrounding stable content. Defaults to 0 (top of doc) until
  // we've seen at least one unchanged block.
  let snapLine = 1
  let lastAnchor = 0

  for (const change of changes) {
    if (change.added) {
      hunks.push({ type: 'add', pmAt: lastAnchor, content: change.value })
      // 'added' lines don't advance snapLine — they don't exist in snapshot.
    } else if (change.removed) {
      // Collect unique block ranges that the removed lines fall into.
      // A 3-line paragraph deletion produces one entry, not three.
      const seen = new Set<string>()
      for (let i = 0; i < (change.count ?? 0); i++) {
        const range = blockMap.get(snapLine + i)
        if (!range) continue
        const key = `${range.pmFrom}:${range.pmTo}`
        if (seen.has(key)) continue
        seen.add(key)
        hunks.push({ type: 'remove', pmFrom: range.pmFrom, pmTo: range.pmTo })
      }
      snapLine += change.count ?? 0
    } else {
      // unchanged: walk the lines so we can park `lastAnchor` at the
      // last unchanged block's pmTo before any subsequent 'add' fires.
      for (let i = 0; i < (change.count ?? 0); i++) {
        const range = blockMap.get(snapLine + i)
        if (range) lastAnchor = range.pmTo
      }
      snapLine += change.count ?? 0
    }
  }

  return hunks
}
