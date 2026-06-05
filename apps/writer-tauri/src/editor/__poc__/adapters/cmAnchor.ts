// CM anchor layer — the CodeMirror counterpart to the PM "(A)" stack
// (anchorSearch + markReconcile + markStamp + the resolve/map core of
// inlineReviewPlugin). This is the artifact measured against PM for the
// LOC/branch comparison.
//
// Why it's so much smaller: in CodeMirror the document IS the markdown
// string, so —
//   - resolve = a literal offset search (no rendered-vs-markdown gap, so
//     none of anchorSearch's wikilink/marker/canonical tiers)
//   - mapping = ChangeSet.mapPos, built in (no hand-written tr.mapping
//     bookkeeping, no idempotent node-reconcile to keep a preview in sync)
//   - accept = a string splice (no materialise-as-nodes + commit dance)
//
// Faithfulness: positions are mapped by the REAL CodeMirror ChangeSet via
// a StateField, exactly as a production CM build would — we don't
// hand-roll offset math, which is the whole point of the comparison.

import { StateField } from '@codemirror/state'

/** The CM-side view of a pending edit — the same three shapes the store
 * emits, minus the rendering metadata this layer doesn't need. */
export interface CmEdit {
  kind: 'add' | 'replace' | 'delete'
  anchorBefore: string
  before?: string
  after?: string
}

/** Resolved placement. `to`/`insertAt` are null when not applicable. */
export type CmAnchor =
  | { status: 'placed'; from: number; to: number | null; insertAt: number | null }
  | { status: 'hunks' }
  | { status: 'unplaced' }
  | { status: 'silent' }

/** Where an `add` lands: end of doc for the empty anchor (append), else
 * just after the LAST occurrence of the anchor text (mirrors PM's
 * last-occurrence rule). */
function resolveAddInsertion(doc: string, anchor: string): number | null {
  if (anchor.length === 0) return doc.length
  const i = doc.lastIndexOf(anchor)
  return i < 0 ? null : i + anchor.length
}

/** Resolve an edit's anchor against the markdown doc string. Pure. */
export function resolveCmAnchor(doc: string, edit: CmEdit): CmAnchor {
  if (edit.kind === 'add') {
    const at = resolveAddInsertion(doc, edit.anchorBefore)
    return at === null
      ? { status: 'unplaced' }
      : { status: 'placed', from: at, to: null, insertAt: at }
  }

  // Whole-file replace (no literal `before`): empty page → a single
  // placed insert at the top; populated page → the disk-derived hunks
  // bucket; identical body → nothing to show.
  if (edit.kind === 'replace' && !edit.before) {
    if (doc.length === 0) return { status: 'placed', from: 0, to: null, insertAt: 0 }
    if ((edit.after ?? '') === doc) return { status: 'silent' }
    return { status: 'hunks' }
  }

  // replace / delete with a literal `before` — first occurrence.
  const target = edit.before
  if (!target) return { status: 'unplaced' }
  const from = doc.indexOf(target)
  if (from < 0) return { status: 'unplaced' }
  const to = from + target.length
  return edit.kind === 'delete'
    ? { status: 'placed', from, to, insertAt: null }
    : { status: 'placed', from, to, insertAt: to }
}

/** A StateField that holds the anchor and keeps it live across edits:
 * `placed` positions ride ChangeSet.mapPos; `unplaced`/`silent` re-resolve
 * (a doc change may have brought the target into existence — the CM analog
 * of inlineReviewPlugin's re-resolution branch). Created per edit so the
 * field closes over it. */
export function makeAnchorField(edit: CmEdit): StateField<CmAnchor> {
  return StateField.define<CmAnchor>({
    create: (state) => resolveCmAnchor(state.doc.toString(), edit),
    update(value, tr) {
      if (!tr.docChanged) return value
      if (value.status === 'placed') {
        // assoc chosen so text inserted exactly at a boundary stays
        // OUTSIDE the anchor: from biases right, to biases left.
        return {
          status: 'placed',
          from: tr.changes.mapPos(value.from, 1),
          to: value.to === null ? null : tr.changes.mapPos(value.to, -1),
          insertAt: value.insertAt === null ? null : tr.changes.mapPos(value.insertAt, 1),
        }
      }
      if (value.status === 'unplaced' || value.status === 'silent') {
        return resolveCmAnchor(tr.newDoc.toString(), edit)
      }
      return value
    },
  })
}

/** Accept (Keep): apply the edit to the doc string and return the new
 * body. A splice for replace/delete, an insert for add, the new body for
 * a whole-file replace. */
export function acceptCmAnchor(doc: string, anchor: CmAnchor, edit: CmEdit): string {
  if (anchor.status === 'hunks') return edit.after ?? doc
  if (anchor.status !== 'placed') return doc

  if (edit.kind === 'delete' && anchor.to !== null) {
    return doc.slice(0, anchor.from) + doc.slice(anchor.to)
  }
  if (edit.kind === 'replace') {
    // literal-before replace splices the range; whole-file replace on an
    // empty page (to === null) just becomes the new body.
    if (anchor.to !== null) {
      return doc.slice(0, anchor.from) + (edit.after ?? '') + doc.slice(anchor.to)
    }
    return edit.after ?? ''
  }
  if (edit.kind === 'add' && anchor.insertAt !== null) {
    const at = anchor.insertAt
    const body = edit.after ?? ''
    // Appending to a non-empty doc gets a blank line, matching the block
    // separation a new paragraph carries.
    const insert = at === doc.length && doc.length > 0 ? `\n\n${body}` : body
    return doc.slice(0, at) + insert + doc.slice(at)
  }
  return doc
}
