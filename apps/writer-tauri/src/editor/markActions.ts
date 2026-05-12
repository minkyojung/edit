/**
 * Client-side mark actions: accept / reject / dismiss.
 *
 * These bypass the proof-server's HTTP ops API and operate directly on the
 * ProseMirror EditorView + Yjs Y.Map. Yjs auto-syncs both the doc text
 * (via y-prosemirror) and the Y.Map metadata to the server, mirroring how
 * proof-sdk's web client behaves.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark, Node } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { StoredMark } from '../hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { ANCHOR_PROOF_MARK_NAMES } from './markTypes'

/** Position of the slot directly after the top-level block that
 * contains `pos`. acceptMark uses this to materialize INSERT
 * proposals at the same spot the markDecoPlugin's ghost widget
 * was previewing them, so accept reads as "the preview became
 * real" without a layout jump. depth=1 because depth 0 is the
 * doc itself; the top-level block is always at depth 1. */
function topLevelSiblingAfter(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  return Math.min($pos.end(1) + 1, doc.content.size)
}

interface FoundAnchor {
  from: number
  to: number
  mark: Mark
}

function findInlineAnchor(
  view: EditorView,
  markId: string,
  schemaName?: string,
): FoundAnchor | null {
  const targets = schemaName ? [schemaName] : ANCHOR_PROOF_MARK_NAMES
  let result: FoundAnchor | null = null
  view.state.doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if ((targets as readonly string[]).includes(m.type.name) && m.attrs.id === markId) {
        result = { from: pos, to: pos + node.nodeSize, mark: m }
        return false
      }
    }
  })
  return result
}

/**
 * Whether the live PM doc still carries a `proofSuggestion` mark with
 * this id. Returns true the moment any text node along the mark's
 * range has the suggestion attached, false otherwise.
 *
 * Why this exists: callers (hover toolbar, popover) used to gate
 * visibility on the Y.Map<StoredMark> entry — but Y.Map mutations are
 * NOT undone by ProseMirror's undo stack, so Cmd+Z after accept/reject
 * restored the PM mark while leaving Y.Map empty, hiding the affordance
 * even though the visual was back. Aligning visibility on the PM mark
 * itself matches the codebase's stated invariant
 * (markCleanupPlugin.ts:1-7): "the inline ProseMirror mark is the
 * single source of truth for whether a mark exists; Y.Map just holds
 * metadata."
 */
export function hasProofSuggestionInDoc(
  view: EditorView,
  markId: string,
): boolean {
  return findInlineAnchor(view, markId, 'proofSuggestion') !== null
}

/**
 * Return the live `proofComment` Mark for `markId`, or null if no such
 * mark exists in the doc. Used by MarkPopoverLayer to read the comment
 * body / quote / rationale directly off the PM mark — same Cmd+Z-safe
 * pattern as hasProofSuggestionInDoc applies to comments now that the
 * proofComment schema carries text / quote / note attrs itself.
 */
export function getProofCommentMark(
  view: EditorView,
  markId: string,
): Mark | null {
  return findInlineAnchor(view, markId, 'proofComment')?.mark ?? null
}

export function acceptMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] accept: anchor not found', markId)
    notify.markCantApply()
    return false
  }
  const { from, to, mark } = anchor
  const kind = mark.attrs.kind as 'replace' | 'insert' | 'delete'
  // Pull content from the Y.Map StoredMark, not the PM mark attrs. The
  // server's markdown projection can strip mark.attrs.content during a
  // reconciliation round-trip; the Y.Map metadata syncs through Yjs binary
  // and survives that path intact.
  const marksMap = ydoc.getMap<StoredMark>('marks')
  const stored = marksMap.get(markId)
  const content = stored?.content ?? null

  const tr = view.state.tr
  // Inserted-content range for the post-dispatch provenance addMark.
  // Set by the kind branches that produce a stable region of new text;
  // delete leaves it null (there is no inserted text to breadcrumb).
  let provenanceRange: { from: number; to: number } | null = null
  if (kind === 'delete') {
    tr.delete(from, to)
  } else if (kind === 'replace') {
    if (content === null || content === undefined) {
      notify.markCantRead()
      return false
    }
    const replacement = view.state.schema.text(content)
    tr.replaceWith(from, to, replacement)
    provenanceRange = { from, to: from + replacement.nodeSize }
  } else if (kind === 'insert') {
    // Anchor model (proof-sdk pattern): the mark sits on an existing
    // user word; the proposed content lives only in Y.Map.content and
    // is shown to the user via markDecoPlugin's ghost widget. Accept
    // is the moment that promise is realised — parse the markdown,
    // insert it as real PM blocks at the top-level sibling slot after
    // the anchor's containing block (same spot the ghost widget was
    // previewing), and strip the suggestion mark from the anchor.
    // Single transaction so Cmd+Z restores the pre-accept state in
    // one step; the server sees a normal PM transaction and accepts
    // it as canonical (no drift, no revert — that was the trap the
    // PM-tree materializer fell into).
    if (content === null || content === undefined) {
      notify.markCantRead()
      return false
    }
    const parser = useEditorViewStore.getState().parser
    if (!parser) {
      console.error('[markActions] accept(insert): parser not ready')
      notify.markEditorNotReady()
      return false
    }
    const parsed = parser(content)
    if (!parsed || parsed.content.size === 0) {
      console.error('[markActions] accept(insert): parser produced empty doc', content)
      notify.markCantRead()
      return false
    }
    const suggestionType = view.state.schema.marks.proofSuggestion
    const insertPos = topLevelSiblingAfter(view.state.doc, to)
    const fragmentSize = parsed.content.size
    if (suggestionType) tr.removeMark(from, to, suggestionType)
    tr.insert(insertPos, parsed.content)
    provenanceRange = { from: insertPos, to: insertPos + fragmentSize }
  } else {
    return false
  }

  // Wrap the PM dispatch + Y.Map cleanup in one Yjs transaction with
  // a tracked origin so they sit in the same undo step. Without this,
  // Cmd+Z would only undo the PM half (proofSuggestion mark restored)
  // and the marks map would stay deleted — a re-accept would then hit
  // an empty Y.Map and bail with markCantRead. The 'mark-action'
  // origin is whitelisted in the UndoManager configured by
  // MilkdownEditor; PM transactions run inside view.dispatch already
  // open their own ydoc.transact, but Yjs collapses nested transacts
  // so origin/scope stay consistent across both ops.
  ydoc.transact(() => {
    view.dispatch(tr)
    marksMap.delete(markId)
  }, 'mark-action')

  // Stamp proofProvenance in a SEPARATE Yjs transaction after the
  // doc-content commit lands. Earlier attempts that bundled both into
  // a single tr triggered the proof-server reconciliation's drift
  // detection on `replace` accepts and the body was reverted to
  // empty — same projection-wipe pattern proof-sdk's collab.ts
  // calls out (`recordProjectionWipeWarning`). Splitting separates
  // the user-edit step (server sees a normal text mutation) from
  // the metadata-only step (server sees a mark addition over text
  // that already exists in its projection), each cleanly matching
  // one of the proof-sdk edit modes server-side. Cmd+Z costs one
  // extra keystroke for the mark layer, which is acceptable for
  // the safety win.
  const provenanceType = view.state.schema.marks.proofProvenance
  if (provenanceType && provenanceRange && stored) {
    ydoc.transact(() => {
      const tr2 = view.state.tr
      tr2.addMark(
        provenanceRange.from,
        provenanceRange.to,
        provenanceType.create({
          id: markId,
          sourceSlug: stored.sourceSlug ?? null,
          sourceLabel: stored.sourceLabel ?? null,
          sourceQuote: stored.sourceQuote ?? null,
          createdAt: stored.createdAt ?? stored.proposedAt ?? stored.at ?? null,
          acceptedAt: new Date().toISOString(),
          model: stored.model ?? null,
        }),
      )
      view.dispatch(tr2)
    }, 'mark-action')
  }
  return true
}

export function rejectMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] reject: anchor not found', markId)
    notify.markCantDismiss()
    return false
  }
  const { from, to } = anchor
  // Anchor model (all kinds): the mark sits on existing user text,
  // never on AI-inserted content (the candidate content lives in
  // Y.Map.content and is shown via the ghost widget — never in the
  // PM tree until accept). Reject is therefore just "strip the mark
  // and drop the Y.Map entry"; the user's text is untouched. This
  // also undoes the dangerous reject(insert) of the PM-tree era,
  // which deleted every top-level block carrying the mark — those
  // blocks were sometimes the user's own writing.
  const markType = view.state.schema.marks.proofSuggestion
  // Same atomic dispatch + Y.Map.delete as acceptMark: one Yjs
  // transaction with a tracked origin so Cmd+Z brings BOTH the PM
  // mark and the Y.Map metadata back together. Otherwise reject →
  // Cmd+Z → re-attempt would surface the same missing-content bug
  // accept used to have.
  ydoc.transact(() => {
    view.dispatch(view.state.tr.removeMark(from, to, markType))
    ydoc.getMap<StoredMark>('marks').delete(markId)
  }, 'mark-action')
  return true
}

/** Silently remove a propose_change-produced mark (suggestion or comment).
 * Used when the assistant turn that owns the mark is being discarded —
 * e.g. handleRegenerate clearing the prior run's marks before the rerun
 * stamps fresh ones. Same effect as rejectMark / resolveComment but
 * without the user-facing notify side effect on missing anchors. */
export function cleanupMark(view: EditorView, ydoc: Y.Doc, markId: string): void {
  const stored = ydoc.getMap<StoredMark>('marks').get(markId)
  const schemaName = stored?.kind === 'comment' ? 'proofComment' : 'proofSuggestion'
  const anchor = findInlineAnchor(view, markId, schemaName)
  if (anchor) {
    const markType = view.state.schema.marks[schemaName]
    if (markType) {
      view.dispatch(view.state.tr.removeMark(anchor.from, anchor.to, markType))
    }
  }
  ydoc.getMap<StoredMark>('marks').delete(markId)
}
