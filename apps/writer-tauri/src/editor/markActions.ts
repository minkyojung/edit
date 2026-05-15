/**
 * Mark actions: accept / reject / dismiss.
 *
 * State changes (accept = apply suggestion content + flip mark to
 * accepted, reject = drop the suggestion) route through proof-server's
 * canonical mutation surface (`POST /documents/:slug/ops`) so the
 * server originates the Yjs update. Drift detection can't fire on
 * changes the server itself produced, which retires the split-tr +
 * anchor-on-existing-text workarounds the previous direct-Y.Map path
 * needed to dodge revert races.
 *
 * Auxiliary `Y.Map('authoredMeta')` writes (sourceSlug / model /
 * acceptedAt — fields proof-sdk doesn't model) stay client-side after
 * a successful accept. The server treats that map as opaque binary
 * (per the comment in `useCollabDoc.AuthoredMeta`), so writing it
 * locally doesn't trigger any reconciliation path.
 *
 * Read-only helpers (findInlineAnchor / hasProofSuggestionInDoc /
 * getProofCommentMark) stay unchanged — they're how the hover bar and
 * popover decide visibility off the live PM mark.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import type { StoredMark } from '../hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { ANCHOR_PROOF_MARK_NAMES } from './markTypes'
import { markStore } from '@/domain/markStoreInstance'

interface FoundAnchor {
  from: number
  to: number
  mark: Mark
}

export function findInlineAnchor(
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
 * Why this exists: callers (hover toolbar, popover) gate visibility
 * on the inline PM mark, not on the `Y.Map<StoredMark>` entry. PM
 * undo restores the mark; Y.Map mutations from accept/reject aren't
 * on PM's undo stack, so a Y.Map-gated check would hide the
 * affordance after Cmd+Z even though the suggestion is back in the
 * doc. Aligning visibility on the PM mark matches the codebase's
 * stated invariant (markCleanupPlugin.ts:1-7): "the inline
 * ProseMirror mark is the single source of truth for whether a mark
 * exists; Y.Map just holds metadata."
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

/**
 * Accept a `proofSuggestion` mark.
 *
 * Phase 2.3 — re-routed off `proofClient.ops` to `markStore.accept`.
 * The server path failed with 404 ("Mark not found") whenever the
 * mark was created locally via markStore.add (Phase 2.4), since the
 * server never saw it. Both add + accept now flow through markStore;
 * the server is bypassed for the entire suggestion lifecycle.
 *
 * markStore.accept handles internally:
 *   - drift check (mark.quote vs current text → status='stale' if
 *     diverged, no body mutation, returns false)
 *   - body mutation per suggestionType (insert / delete / replace)
 *   - authored breadcrumb mark stamped over the inserted range
 *   - everything under a single 'mark-action' Yjs origin so the
 *     UndoManager reverses it as one Cmd+Z step
 *
 * `view` and `ydoc` parameters are kept on the signature for caller
 * compatibility (Phase 2 migration ground rule — change one thing at
 * a time). They are unused now; the markStore resolves them from
 * the store registry internally.
 */
export async function acceptMark(
  slug: string,
  _view: EditorView,
  _ydoc: Y.Doc,
  markId: string,
  by: string = 'human:unknown',
): Promise<boolean> {
  const ok = await markStore.accept({ slug, markId, by })
  if (!ok) {
    notify.markCantApply()
  }
  return ok
}

/**
 * Reject a `proofSuggestion` mark.
 *
 * Phase 2.2 — re-routed off `proofClient.ops` to `markStore.reject`.
 * Symmetric with acceptMark above. Reject is the simpler of the two
 * (no body mutation, no drift check) — just removes the inline PM
 * mark and the Y.Map entry under a single 'mark-action' origin.
 */
export async function rejectMark(
  slug: string,
  _view: EditorView,
  markId: string,
  by: string = 'human:unknown',
): Promise<boolean> {
  const ok = await markStore.reject({ slug, markId, by })
  if (!ok) {
    notify.markCantDismiss()
  }
  return ok
}

/**
 * Silently remove a `propose_change`-produced mark (suggestion or
 * comment). Used when the assistant turn that owns the mark is being
 * discarded — e.g. handleRegenerate clearing the prior run's marks
 * before the rerun stamps fresh ones.
 *
 * Two paths:
 *   1. Fast path — slug is active. The markStore resolves the live
 *      EditorView and removes both the PM mark and the Y.Map entry
 *      under a single 'mark-action' origin (so UndoManager sees one
 *      step). For comments, this calls accept() which is the
 *      resolved-equivalent.
 *   2. Fallback — slug isn't active (regenerate fired on a chat whose
 *      target doc isn't currently mounted). We can't dispatch a PM
 *      transaction without a view, so we delete just the Y.Map entry.
 *      markCleanupPlugin handles PM mark removal the next time the
 *      user opens the doc.
 *
 * No user-facing toast on failure; the rerun path shouldn't be
 * interrupted by mark cleanup hiccups.
 *
 * Phase 2.1 — first call site migrated off proofClient.ops. The
 * `ydoc` parameter is retained for the fallback path; once Phase 3
 * lands and proof-server is gone, the live-only markStore path will
 * handle every meaningful case and the fallback can collapse.
 */
export async function cleanupMark(
  slug: string,
  ydoc: Y.Doc | null,
  markId: string,
  by: string = 'ai:unknown',
): Promise<void> {
  const stored = markStore.get(slug, markId)
  if (stored) {
    if (stored.kind === 'comment') {
      await markStore.accept({ slug, markId, by })
    } else {
      await markStore.reject({ slug, markId, by })
    }
    return
  }

  // Fallback: slug isn't active or markStore couldn't resolve it.
  // Drop the Y.Map metadata so the entry doesn't orphan; the inline
  // PM mark gets swept by markCleanupPlugin on next mount.
  if (!ydoc) return
  if (!ydoc.getMap<StoredMark>('marks').has(markId)) return
  ydoc.transact(() => {
    ydoc.getMap<StoredMark>('marks').delete(markId)
  }, 'mark-action')
}
