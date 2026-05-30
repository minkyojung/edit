// Reconcile engine for the mark-native pending-edit model.
//
// pending ADD content is materialised in the live PM doc as real
// nodes (so Milkdown NodeViews render it identically to committed
// body), each tagged with a `proofSuggestion` mark whose
// `kind === 'insert'` and whose `id` is the stable per-edit key
// (`${change.id}:${edit.id}`). Phase 0's stripPendingFromDoc keeps
// that content off disk.
//
// The challenge node-based rendering introduces (over the old
// decoration approach) is idempotency: inserting on every store
// update would duplicate. This module computes the single transaction
// that makes the doc's pending-insert nodes MATCH a desired set —
// insert the missing, remove the stale, leave the rest untouched —
// keyed by markId. Pure + transaction-only so it's unit-testable in
// isolation and the caller (inlineReviewPlugin) owns dispatch.
//
// Scope: block-level pending adds (a new paragraph / bullet / heading),
// which is what `add` edits actually are. Inline-partial pending
// (a phrase spliced mid-paragraph — the replace-with-inline-after
// case) is NOT handled here; that path stays on decorations.

import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Fragment, Mark, Node as PMNode } from '@milkdown/kit/prose/model'
import { isBlockFullyPending, isInsertMarked } from '@/lib/stripPendingFromDoc'
import { proofSuggestionType, stampPending } from './markStamp'

/** One pending add the doc should contain. `content` is fresh,
 * UNMARKED block content (the engine stamps the insert mark itself);
 * `insertPos` is a block-boundary document position the caller
 * resolved from the edit's anchor. */
export interface DesiredInsert {
  markId: string
  content: Fragment
  insertPos: number
}

/** Convert an inline document position into the block-boundary position
 * just AFTER the top-level block that contains it — where a new
 * top-level block (the pending add) can validly land.
 *
 * `add` anchors resolve to an inline position (the end of the matched
 * anchor text, or `content.size` for append). Inserting a block there
 * would split the host paragraph; lifting to the enclosing top-level
 * block's trailing boundary keeps the inserted block a clean sibling.
 *
 * Nested positions (a pos inside a list_item) lift to the boundary
 * after the WHOLE top-level container (the list) — the MVP inserts
 * added blocks at the top level rather than splicing a sibling
 * list_item. `content.size` and already-at-boundary positions pass
 * through unchanged. */
export function blockBoundaryAfter(doc: PMNode, inlinePos: number): number {
  const size = doc.content.size
  if (inlinePos >= size) return size
  if (inlinePos <= 0) return inlinePos
  const $pos = doc.resolve(inlinePos)
  if ($pos.depth === 0) return inlinePos // already between top-level blocks
  return $pos.after(1)
}

/** The insert-mark id carried by a pending block, or null if it has
 * no insert-marked text. Reads the first insert-marked text leaf;
 * a materialised block is stamped uniformly so the first is
 * representative. */
function blockInsertId(node: PMNode): string | null {
  let id: string | null = null
  node.descendants((d) => {
    if (id !== null) return false
    if (d.isText && isInsertMarked(d)) {
      id = (getSuggestionMark(d)?.attrs.id as string | null) ?? null
      return false
    }
    return true
  })
  return id
}

/** Locate every materialised pending-add block in `doc`, keyed by
 * markId, with the OUTER range to delete on removal (block range, so
 * removal leaves no empty wrapper). Mirrors stripPendingFromDoc's
 * block detection (shared predicate) but records the id + position. */
function presentInserts(doc: PMNode): Map<string, { from: number; to: number }> {
  const present = new Map<string, { from: number; to: number }>()
  doc.descendants((node, pos) => {
    if (node.isBlock && isBlockFullyPending(node)) {
      const id = blockInsertId(node)
      if (id !== null && !present.has(id)) {
        present.set(id, { from: pos, to: pos + node.nodeSize })
      }
      return false // whole block accounted for; don't descend
    }
    return true
  })
  return present
}

/** Compute the transaction that makes `state.doc`'s pending-insert
 * blocks match `desired`, or null when already in sync.
 *
 * Order: deletes first (descending `from`, so untouched positions
 * stay valid), then inserts (each `insertPos` mapped through the
 * accumulated mapping to account for the deletes). The whole tr is
 * flagged `addToHistory: false` — materialising pending content must
 * not enter the user's undo stack. */
export function reconcilePendingInserts(
  state: EditorState,
  desired: DesiredInsert[],
): Transaction | null {
  const present = presentInserts(state.doc)
  const desiredIds = new Set(desired.map((d) => d.markId))

  const toRemove = [...present.entries()].filter(([id]) => !desiredIds.has(id))
  const toInsert = desired.filter((d) => !present.has(d.markId))

  if (toRemove.length === 0 && toInsert.length === 0) return null

  const { tr } = state
  const { schema } = state

  // Removes, descending — non-overlapping block ranges so raw
  // positions stay valid without mapping among themselves.
  toRemove
    .map(([, range]) => range)
    .sort((a, b) => b.from - a.from)
    .forEach(({ from, to }) => tr.delete(from, to))

  // Inserts — map each anchor position through the deletes that
  // already landed, then stamp the inserted range with the insert mark.
  for (const { markId, content, insertPos } of toInsert) {
    const pos = tr.mapping.map(insertPos)
    // List-aware: when the content is a list landing right after an
    // existing list of the same type, splice its items INTO that list
    // rather than dropping a second sibling list (two adjacent lists
    // render with their own block margins — a visible spacing seam).
    const merge = listMergeTarget(tr.doc, pos, content)
    if (merge) {
      tr.insert(merge.at, merge.items)
      stampPending(tr, schema, merge.at, merge.at + merge.items.size, 'insert', {
        id: markId,
      })
    } else {
      tr.insert(pos, content)
      stampPending(tr, schema, pos, pos + content.size, 'insert', { id: markId })
    }
  }

  tr.setMeta('addToHistory', false)
  return tr
}

/** If `content` is a single list landing immediately after an existing
 * list of the SAME type (the node ending at `pos`), return where to
 * splice its items inside that list and the items fragment. Otherwise
 * null — the caller inserts `content` as its own block.
 *
 * `pos - 1` sits just inside the existing list's closing token, i.e.
 * the end of its item sequence, so the new items append cleanly. */
function listMergeTarget(
  doc: PMNode,
  pos: number,
  content: Fragment,
): { at: number; items: Fragment } | null {
  if (content.childCount !== 1) return null
  const incoming = content.firstChild
  if (!incoming) return null
  const before = doc.resolve(pos).nodeBefore
  // Same node type + not a textblock ⇒ a list-like container we can
  // merge into. (A paragraph is a textblock, so it's excluded.)
  if (!before || before.type !== incoming.type || before.isTextblock) {
    return null
  }
  return { at: pos - 1, items: incoming.content }
}

/** One pending delete the doc should reflect: an existing body text
 * range `[from, to)` to tag with a `proofSuggestion(kind:'delete')`
 * mark. Unlike inserts, deletes never add or remove nodes — the text
 * stays in the doc (and on disk) until the user clicks Keep; the mark
 * just drives the red / strikethrough styling. */
export interface DesiredDelete {
  markId: string
  from: number
  to: number
}

/** All materialised pending-delete ranges in `doc`, keyed by markId.
 * Contiguous text leaves sharing an id collapse to their union range
 * so a multi-leaf marked span removes cleanly. */
function presentDeletes(doc: PMNode): Map<string, { from: number; to: number }> {
  const present = new Map<string, { from: number; to: number }>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const mark = getSuggestionMark(node)
    if (!mark || mark.attrs.kind !== 'delete') return true
    const id = (mark.attrs.id as string | null) ?? ''
    const from = pos
    const to = pos + node.nodeSize
    const existing = present.get(id)
    if (existing) {
      existing.from = Math.min(existing.from, from)
      existing.to = Math.max(existing.to, to)
    } else {
      present.set(id, { from, to })
    }
    return true
  })
  return present
}

/** Compute the transaction that makes `state.doc`'s pending-delete
 * marks match `desired`, or null when already in sync. Marks don't
 * shift positions, so no mapping is needed between operations. Flagged
 * `addToHistory: false` — same rationale as the insert path. */
export function reconcilePendingDeletes(
  state: EditorState,
  desired: DesiredDelete[],
): Transaction | null {
  const present = presentDeletes(state.doc)
  const desiredIds = new Set(desired.map((d) => d.markId))

  const toRemove = [...present.entries()].filter(([id]) => !desiredIds.has(id))
  const toAdd = desired.filter((d) => !present.has(d.markId))

  if (toRemove.length === 0 && toAdd.length === 0) return null

  const { tr, schema } = state
  const suggestionType = proofSuggestionType(schema)

  for (const [, range] of toRemove) {
    tr.removeMark(range.from, range.to, suggestionType)
  }
  for (const { markId, from, to } of toAdd) {
    stampPending(tr, schema, from, to, 'delete', { id: markId })
  }

  tr.setMeta('addToHistory', false)
  return tr
}

// ── Commit (the Keep path) ──────────────────────────────────────

/** Parse a suggestion mark's id, shaped `${change.id}:${edit.id}[:hunk:i]`.
 * Change ids are colon-free UUIDs, so segment 0 = change, segment 1 =
 * edit. Returns null when the id is missing/malformed. */
export function parseMarkId(
  id: string | null | undefined,
): { changeId: string; editId: string } | null {
  const parts = (id ?? '').split(':')
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  return { changeId: parts[0], editId: parts[1] }
}

export function getSuggestionMark(node: PMNode): Mark | undefined {
  return node.marks.find((m) => m.type.name === 'proofSuggestion')
}

/** True iff every text descendant of `node` carries a delete-mark for
 * `changeId` (and there is at least one) — a wholly-removed block, so
 * Keep deletes the block itself rather than emptying it. */
function isBlockFullyDeleted(node: PMNode, changeId: string): boolean {
  let hasText = false
  let allDeleted = true
  node.descendants((d) => {
    if (d.isText) {
      hasText = true
      const m = getSuggestionMark(d)
      if (!(m && m.attrs.kind === 'delete' && parseMarkId(m.attrs.id as string)?.changeId === changeId)) {
        allDeleted = false
      }
    }
    return true
  })
  return hasText && allDeleted
}

/** Commit a suggestion (the Keep path's doc mutation): in one
 * transaction, KEEP inserted content by removing its insert mark (the
 * node stays as ordinary body) and REMOVE delete-marked content.
 * Returns null when the change has no marks in the doc, else the
 * transaction PLUS the set of `edit.id`s it actually handled.
 *
 * The caller (the applier) needs `handledEditIds` because a single
 * change can be MIXED: some edits materialised as marks (handled here),
 * others live only as decorations or were unplaced (no marks). The
 * applier markdown-applies exactly the edits NOT in this set, so no
 * edit is silently dropped.
 *
 * After this, dirtyTrackerPlugin serialises the now-mark-free doc and
 * flush persists it — no separate markdown re-apply for the handled
 * edits, so the saved page is exactly what was on screen and the cursor
 * isn't disturbed. Flagged `addToHistory: false` to match the
 * convention: AI-driven accept swaps don't enter the user's Cmd+Z stack
 * (reversal is Reject while pending, or git revert once committed). */
export function commitSuggestionInDoc(
  state: EditorState,
  changeId: string,
): { tr: Transaction; handledEditIds: Set<string> } | null {
  const unmark: Array<{ from: number; to: number }> = []
  const remove: Array<{ from: number; to: number }> = []
  const handledEditIds = new Set<string>()

  const note = (mark: Mark): void => {
    const parsed = parseMarkId(mark.attrs.id as string)
    if (parsed && parsed.changeId === changeId) handledEditIds.add(parsed.editId)
  }

  state.doc.descendants((node, pos) => {
    // A wholly delete-marked block is removed outright (no empty
    // residue); don't descend into its leaves.
    if (node.isBlock && isBlockFullyDeleted(node, changeId)) {
      remove.push({ from: pos, to: pos + node.nodeSize })
      node.descendants((d) => {
        if (d.isText) {
          const m = getSuggestionMark(d)
          if (m) note(m)
        }
        return true
      })
      return false
    }
    if (node.isText) {
      const m = getSuggestionMark(node)
      if (m && parseMarkId(m.attrs.id as string)?.changeId === changeId) {
        const span = { from: pos, to: pos + node.nodeSize }
        if (m.attrs.kind === 'insert') unmark.push(span)
        else if (m.attrs.kind === 'delete') remove.push(span)
        note(m)
      }
    }
    return true
  })

  if (unmark.length === 0 && remove.length === 0) return null

  const { tr } = state
  const type = proofSuggestionType(state.schema)
  // Marks first (position-preserving), then deletions back-to-front so
  // the not-yet-processed ranges' positions stay valid.
  for (const r of unmark) tr.removeMark(r.from, r.to, type)
  remove.sort((a, b) => b.from - a.from).forEach((r) => tr.delete(r.from, r.to))
  tr.setMeta('addToHistory', false)
  return { tr, handledEditIds }
}
