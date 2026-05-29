// Serialization guard for the mark-native pending-edit model.
//
// pending-ADD content lives in the live PM doc as real nodes (so
// Milkdown's NodeViews render it identically to committed body), tagged
// with a `proofSuggestion` mark whose `kind === 'insert'`. That content
// must NOT reach disk until the user clicks Keep. The only place the
// live doc becomes disk-bound markdown is dirtyTrackerPlugin's
// `serializer(view.state.doc)` call — so that call serializes
// `stripPendingFromDoc(doc)` instead, which returns a copy with every
// insert-marked region removed.
//
// This is the single choke point that enforces the invariant "pending
// never leaks to disk". Keeping it as one schema-agnostic pure function
// (reads only `mark.type.name` + `mark.attrs.kind`, delegates structural
// integrity to `tr.delete`) keeps the guarantee auditable in one read.

import { EditorState } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/** True iff `node` carries the pending-insert mark. Exported so the
 * reconcile engine (editor/markReconcile.ts) shares one definition of
 * "this content is a pending insert" with the serialization strip. */
export function isInsertMarked(node: PMNode): boolean {
  return node.marks.some(
    (m) => m.type.name === 'proofSuggestion' && m.attrs.kind === 'insert',
  )
}

/** A block is "fully pending" when it has at least one text descendant
 * and EVERY text descendant is insert-marked. Such a block was inserted
 * wholesale as a pending add (a new paragraph / list_item / list) and
 * should be dropped entirely — not just emptied, which would leave a
 * stray blank block in the serialized markdown.
 *
 * The "has at least one text descendant" clause is what protects a
 * user's legitimately-empty paragraph: it has no text, so it is never
 * classified as fully pending.
 *
 * Exported so the reconcile engine can locate whole pending-add blocks
 * to remove using the exact same rule the strip uses to drop them. */
export function isBlockFullyPending(node: PMNode): boolean {
  let hasText = false
  let allMarked = true
  node.descendants((d) => {
    if (d.isText) {
      hasText = true
      if (!isInsertMarked(d)) allMarked = false
    }
    return true
  })
  return hasText && allMarked
}

/** Collect the ranges to delete, as `[from, to]` document positions.
 *
 * Walk order matters: when a block is fully pending we record its OUTER
 * range and stop descending, so we never also emit the inner text
 * leaves (which would double-cover). For blocks that are only partially
 * pending we descend and pick up the individual insert-marked text
 * leaves instead, leaving the surrounding real text in place. */
function collectPendingRanges(doc: PMNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  doc.descendants((node, pos) => {
    if (node.isBlock && isBlockFullyPending(node)) {
      ranges.push([pos, pos + node.nodeSize])
      return false // whole block goes; don't descend into its leaves
    }
    if (node.isText && isInsertMarked(node)) {
      ranges.push([pos, pos + node.nodeSize])
    }
    return true
  })
  return ranges
}

/** Return a copy of `doc` with every pending-insert region removed, or
 * the same `doc` reference unchanged when there is no pending content.
 *
 * Deletions run back-to-front (descending `from`) so each `tr.delete`
 * leaves the positions of the not-yet-processed ranges valid — no
 * position mapping needed. `tr.delete` itself owns the structural
 * fixup (joining, lifting empty wrappers), so this function never does
 * manual Fragment surgery. */
export function stripPendingFromDoc(doc: PMNode): PMNode {
  const ranges = collectPendingRanges(doc)
  if (ranges.length === 0) return doc

  const tr = EditorState.create({ doc }).tr
  ranges.sort((a, b) => b[0] - a[0])
  for (const [from, to] of ranges) {
    tr.delete(from, to)
  }
  return tr.doc
}
