/**
 * Mark actions: accept / reject / dismiss.
 *
 * SPIKE (Sub 1.1.5.1): dual-path mutation. Track 1.1 moved state
 * changes to server-originated (`POST /ops`) which retired the drift-
 * detector workarounds but cost us Cmd+Z (server-broadcast updates
 * don't land under the 'mark-action' origin tracked by the editor's
 * UndoManager). This spike re-introduces the local optimistic apply
 * — same code path the original direct-Yjs implementation used,
 * wrapped in `ydoc.transact(..., 'mark-action')` — while keeping the
 * /ops call so the server still drives canonical state.
 *
 * Two write paths now run in parallel:
 *   1. Local: `ydoc.transact` with origin 'mark-action' → tracked by
 *      Y.UndoManager → Cmd+Z works.
 *   2. Server: `POST /ops { suggestion.accept|reject }` → canonical
 *      state mutation, broadcast echoes back via Hocuspocus.
 *
 * Expected outcome: server's echo arrives carrying the same Yjs
 * update we already applied locally; CRDT merges as a no-op
 * (idempotent). If the server's drift detector fires on the local
 * write before /ops resolves, the spike will surface it as a
 * revert and we pivot to the inverse-op approach (Approach 2).
 *
 * Console markers in this version are temporary instrumentation —
 * remove before the spike is promoted to a real implementation.
 *
 * Read-only helpers (findInlineAnchor / hasProofSuggestionInDoc /
 * getProofCommentMark) stay unchanged.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark, Node } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import { proofClient } from '@/lib/proofClient'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { AuthoredMeta, StoredMark } from '../hooks/useCollabDoc'
import { notify } from '@/lib/notify'
import { ANCHOR_PROOF_MARK_NAMES } from './markTypes'

/** Position of the slot directly after the top-level block that
 * contains `pos`. acceptMark uses this to materialize INSERT
 * proposals at the same spot the markDecoPlugin's ghost widget
 * was previewing them. depth=1 because depth 0 is the doc; the
 * top-level block is always at depth 1. */
function topLevelSiblingAfter(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  return Math.min($pos.end(1) + 1, doc.content.size)
}

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

export function hasProofSuggestionInDoc(
  view: EditorView,
  markId: string,
): boolean {
  return findInlineAnchor(view, markId, 'proofSuggestion') !== null
}

export function getProofCommentMark(
  view: EditorView,
  markId: string,
): Mark | null {
  return findInlineAnchor(view, markId, 'proofComment')?.mark ?? null
}

/**
 * Accept a `proofSuggestion` mark.
 *
 * Dual-path: apply locally first (origin='mark-action' so UndoManager
 * tracks it → Cmd+Z works), then fire-and-await /ops so the server
 * is told to canonicalize the same change. Server's echo through
 * Hocuspocus arrives carrying an equivalent Yjs update; CRDT merges
 * it as idempotent.
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
  const { from, to, mark } = anchor
  const kind = mark.attrs.kind as 'replace' | 'insert' | 'delete'

  // Read content for replace/insert from the Y.Map (server's projection
  // can strip mark.attrs.content during reconciliation; Y.Map syncs
  // through Yjs binary and survives that path).
  const marksMap = ydoc.getMap<StoredMark>('marks')
  const stored = marksMap.get(markId)
  const content = stored?.content ?? null

  // === LOCAL OPTIMISTIC APPLY ===
  const tr = view.state.tr
  let authoredRange: { from: number; to: number } | null = null

  if (kind === 'delete') {
    tr.delete(from, to)
  } else if (kind === 'replace') {
    if (content === null || content === undefined) {
      notify.markCantRead()
      return false
    }
    const replacement = view.state.schema.text(content)
    tr.replaceWith(from, to, replacement)
    authoredRange = { from, to: from + replacement.nodeSize }
  } else if (kind === 'insert') {
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
    authoredRange = { from: insertPos, to: insertPos + fragmentSize }
  } else {
    return false
  }

  // Stamp proofAuthored on the inserted/replaced range in the SAME
  // tr so the breadcrumb tracks with the content atomically. Pattern
  // mirrors proof-sdk's web client (marks.ts applyMarkdownReplace /
  // applyMarkdownInsert).
  const authoredType = view.state.schema.marks.proofAuthored
  if (authoredType && authoredRange) {
    tr.addMark(
      authoredRange.from,
      authoredRange.to,
      authoredType.create({
        id: markId,
        by: stored?.by ?? 'ai:unknown',
      }),
    )
  }

  // Single ydoc.transact wraps the PM dispatch + Y.Map cleanup so
  // Cmd+Z restores text, suggestion mark, authored mark, and the
  // Y.Map entry atomically. 'mark-action' origin is in the editor's
  // trackedOrigins set (see MilkdownEditor.tsx:312).
  const authoredMetaMap = ydoc.getMap<AuthoredMeta>('authoredMeta')
  console.log('[spike] accept: applying local mutation', { markId, kind })
  ydoc.transact(() => {
    view.dispatch(tr)
    marksMap.delete(markId)
    if (authoredRange && stored) {
      authoredMetaMap.set(markId, {
        sourceSlug: stored.sourceSlug,
        sourceLabel: stored.sourceLabel,
        sourceQuote: stored.sourceQuote,
        createdAt: stored.createdAt ?? stored.proposedAt ?? stored.at,
        acceptedAt: new Date().toISOString(),
        model: stored.model,
      })
    }
  }, 'mark-action')

  // === SERVER CANONICAL APPLY ===
  // /ops call runs after the local apply. If the server confirms,
  // its echo arrives via Hocuspocus carrying the same change; CRDT
  // merges as no-op. If the server fails, the local change stays
  // (TODO: rollback) — the spike doesn't implement rollback yet.
  console.log('[spike] accept: calling /ops', { markId, by })
  try {
    await proofClient.ops(slug, null, {
      type: 'suggestion.accept',
      markId,
      by,
    })
    console.log('[spike] accept: /ops succeeded', { markId })
  } catch (err) {
    console.error('[spike] accept: /ops failed — local apply stayed (no rollback in spike)', err)
    notify.markCantApply()
    // Note: we don't reverse the local apply here. Real implementation
    // will need to either undo the transaction or pop the UndoManager
    // step. For the spike, we surface the toast and observe whether
    // the server's eventual reconciliation cleans things up.
    return false
  }

  return true
}

/**
 * Reject a `proofSuggestion` mark — same dual-path pattern.
 */
export async function rejectMark(
  slug: string,
  view: EditorView,
  ydoc: Y.Doc,
  markId: string,
  by: string = 'human:unknown',
): Promise<boolean> {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] reject: anchor not found', markId)
    notify.markCantDismiss()
    return false
  }
  const { from, to } = anchor

  const markType = view.state.schema.marks.proofSuggestion

  console.log('[spike] reject: applying local mutation', { markId })
  ydoc.transact(() => {
    view.dispatch(view.state.tr.removeMark(from, to, markType))
    ydoc.getMap<StoredMark>('marks').delete(markId)
  }, 'mark-action')

  console.log('[spike] reject: calling /ops', { markId, by })
  try {
    await proofClient.ops(slug, null, {
      type: 'suggestion.reject',
      markId,
      by,
    })
    console.log('[spike] reject: /ops succeeded', { markId })
  } catch (err) {
    console.error('[spike] reject: /ops failed — local apply stayed (no rollback in spike)', err)
    notify.markCantDismiss()
    return false
  }

  return true
}

/**
 * Silently remove a `propose_change`-produced mark (suggestion or
 * comment). Used by chat regenerate flow. Keeps the /ops-only path
 * from Track 1.1 — cleanup isn't user-driven so Cmd+Z doesn't apply.
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
