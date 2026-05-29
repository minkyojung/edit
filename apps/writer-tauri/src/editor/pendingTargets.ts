// Adapter: anchor resolution → reconcile targets.
//
// inlineReviewPlugin's `resolveAnchor` already does the hard work of
// pinning an edit's intent to live PM positions (or declaring it
// unplaced). This module translates that resolution into the
// `DesiredInsert` / `DesiredDelete` inputs the mark-native reconcile
// engine consumes — keeping the position arithmetic (block-boundary
// lifting, per-hunk markId minting) as one pure, unit-tested step.
//
// Scope split (see the Phase 1b plan): only BLOCK-shaped pending goes
// mark-native here —
//   - `add`                       → one insert
//   - whole-file `replace` (hunks) → insert per add-hunk, delete per
//                                     remove-hunk
// INLINE-shaped pending (`replace` with a literal `before`, pure
// `delete`) returns no targets: those stay on the decoration + widget
// path in inlineReviewPlugin for now (inline strike + small widget,
// where there's no block NodeView to mismatch against).

import type { Node as PMNode, Fragment } from '@milkdown/kit/prose/model'
import {
  blockBoundaryAfter,
  type DesiredInsert,
  type DesiredDelete,
} from './markReconcile'
import { splitEdit } from '@/lib/intraEditDiff'
import type { AnchorResolution } from './inlineReviewPlugin'

/** Minimal view of a PendingEdit — only the fields the adapter reads.
 * Kept local so this module doesn't couple to the full store type. */
interface EditShape {
  kind: 'add' | 'replace' | 'delete'
  before?: string
  after?: string
}

export interface PendingTargets {
  inserts: DesiredInsert[]
  deletes: DesiredDelete[]
}

const EMPTY: PendingTargets = { inserts: [], deletes: [] }

/** True for the block-shaped insert cases the mark-native path owns:
 * a pure `add`, or a whole-file `replace` whose `before` is absent
 * (the declarative new-body shape, rendered on an empty page as a
 * single placed insert). */
function isBlockInsert(edit: EditShape): boolean {
  return edit.kind === 'add' || (edit.kind === 'replace' && !edit.before)
}

/** True for the common "add a new line/bullet after an anchor"
 * idiom: the model expresses an insertion as a replace whose `before`
 * is the anchor line and whose `after` is that line PLUS new block
 * content. After trimming the shared head/tail, nothing is removed and
 * the added delta is block-shaped (spans a new line). Routed to the
 * reconcile insert path so the new content renders as a real node
 * BELOW the anchor — not appended inline. Guarded to a single-line
 * `before` so the strike/position arithmetic stays char-exact.
 *
 * Exported so inlineReviewPlugin's decoration path can recognise the
 * same shape and defer to the node path instead of double-rendering. */
export function isBlockInsertionReplace(edit: EditShape): boolean {
  if (edit.kind !== 'replace' || !edit.before) return false
  if (edit.before.includes('\n')) return false
  const { removed, added } = splitEdit(edit.before, edit.after ?? '')
  return removed.length === 0 && added.trim().length > 0 && added.includes('\n')
}

export function anchorToTargets(
  resolution: AnchorResolution,
  markIdBase: string,
  edit: EditShape,
  doc: PMNode,
  parse: (md: string) => Fragment,
): PendingTargets {
  if (resolution.status === 'placed') {
    // Pure add / declarative new-body → insert the whole `after`.
    if (isBlockInsert(edit)) {
      const after = edit.after ?? ''
      if (!after.trim()) return EMPTY
      const at = resolution.anchor.insertAt ?? doc.content.size
      return {
        inserts: [
          { markId: markIdBase, content: parse(after), insertPos: blockBoundaryAfter(doc, at) },
        ],
        deletes: [],
      }
    }
    // "Add a new bullet after this line" expressed as a replace →
    // insert only the added delta as a real node below the anchor.
    if (isBlockInsertionReplace(edit)) {
      const { added } = splitEdit(edit.before ?? '', edit.after ?? '')
      const at = resolution.anchor.insertAt ?? resolution.anchor.to ?? doc.content.size
      return {
        inserts: [
          { markId: markIdBase, content: parse(added), insertPos: blockBoundaryAfter(doc, at) },
        ],
        deletes: [],
      }
    }
    // Inline replace-with-before / pure delete → decoration path.
    return EMPTY
  }

  if (resolution.status === 'hunks') {
    const inserts: DesiredInsert[] = []
    const deletes: DesiredDelete[] = []
    resolution.hunks.forEach((hunk, i) => {
      const markId = `${markIdBase}:hunk:${i}`
      if (hunk.type === 'remove') {
        deletes.push({ markId, from: hunk.pmFrom, to: hunk.pmTo })
      } else if (hunk.content.trim()) {
        inserts.push({
          markId,
          content: parse(hunk.content),
          insertPos: blockBoundaryAfter(doc, hunk.pmAt),
        })
      }
    })
    return { inserts, deletes }
  }

  // 'unplaced' / 'silent' — nothing to materialise.
  return EMPTY
}
