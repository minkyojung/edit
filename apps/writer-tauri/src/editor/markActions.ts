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
import { proofClient } from '@/lib/proofClient'
import type { AuthoredMeta, StoredMark } from '../hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { ANCHOR_PROOF_MARK_NAMES } from './markTypes'

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
 * Calls `POST /ops { type: 'suggestion.accept' }`; the server applies
 * the content (insert / delete / replace), flips the mark to
 * `status: 'accepted'`, and broadcasts the resulting Yjs update.
 * The local doc catches up via the existing HocuspocusProvider
 * WebSocket — no client-side PM mutation needed.
 *
 * Post-success we write the app-specific breadcrumb (sourceSlug,
 * model, acceptedAt) into `Y.Map('authoredMeta')`. Those fields
 * aren't part of proof-sdk's mark schema, so the server doesn't
 * carry them; keeping them client-side preserves the "where did
 * this come from?" hover that EditorFooter and the popover read.
 *
 * Returns true on a 2xx response. Fail-fast on missing anchor
 * (mark already gone) so the user sees a clean "no longer applies"
 * toast instead of a 404 from the server.
 */
export async function acceptMark(
  slug: string,
  view: EditorView,
  ydoc: Y.Doc,
  markId: string,
  by: string = 'human:unknown',
): Promise<boolean> {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] accept: anchor not found', markId)
    notify.markCantApply()
    return false
  }

  // Snapshot the client-side metadata before the server's accept
  // round-trip. The Y.Map entry may get cleaned up by markCleanup
  // once the server-originated update strips the inline mark, so we
  // capture sourceSlug / model / etc. now and stamp authoredMeta
  // only after the ops call succeeds.
  const stored = ydoc.getMap<StoredMark>('marks').get(markId)

  try {
    await proofClient.ops(slug, null, {
      type: 'suggestion.accept',
      markId,
      by,
    })
  } catch (err) {
    console.error('[markActions] accept failed', err)
    notify.markCantApply()
    return false
  }

  if (stored) {
    ydoc.getMap<AuthoredMeta>('authoredMeta').set(markId, {
      sourceSlug: stored.sourceSlug,
      sourceLabel: stored.sourceLabel,
      sourceQuote: stored.sourceQuote,
      createdAt: stored.createdAt ?? stored.proposedAt ?? stored.at,
      acceptedAt: new Date().toISOString(),
      model: stored.model,
    })
  }

  return true
}

/**
 * Reject a `proofSuggestion` mark.
 *
 * Calls `POST /ops { type: 'suggestion.reject' }`. Server drops the
 * inline mark and broadcasts the update. No local metadata stamp —
 * unlike accept, reject has nothing to breadcrumb.
 */
export async function rejectMark(
  slug: string,
  view: EditorView,
  markId: string,
  by: string = 'human:unknown',
): Promise<boolean> {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] reject: anchor not found', markId)
    notify.markCantDismiss()
    return false
  }

  try {
    await proofClient.ops(slug, null, {
      type: 'suggestion.reject',
      markId,
      by,
    })
  } catch (err) {
    console.error('[markActions] reject failed', err)
    notify.markCantDismiss()
    return false
  }

  return true
}

/**
 * Silently remove a `propose_change`-produced mark (suggestion or
 * comment). Used when the assistant turn that owns the mark is being
 * discarded — e.g. handleRegenerate clearing the prior run's marks
 * before the rerun stamps fresh ones.
 *
 * Same surface as reject for suggestions, `comment.resolve` for
 * comments. No user-facing toast on failure; the rerun path
 * shouldn't be interrupted by mark cleanup hiccups.
 */
export async function cleanupMark(
  slug: string,
  ydoc: Y.Doc | null,
  markId: string,
  by: string = 'ai:unknown',
): Promise<void> {
  const stored = ydoc?.getMap<StoredMark>('marks').get(markId)
  const op: { type: 'suggestion.reject' | 'comment.resolve'; markId: string; by: string } =
    stored?.kind === 'comment'
      ? { type: 'comment.resolve', markId, by }
      : { type: 'suggestion.reject', markId, by }
  try {
    await proofClient.ops(slug, null, op)
  } catch (err) {
    console.warn('[markActions] cleanup failed', err)
  }
}
