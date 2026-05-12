// Apply layer for ingest review — turns queued proposals into
// proofSuggestion marks inside the target wiki page. Each proposal
// becomes one inline mark anchored on the doc's last non-empty word;
// the proposed content rides on Y.Map<StoredMark>('marks').content,
// and a Decoration.widget (markDecoPlugin) shows it inline as a ghost
// preview so the user sees the candidate without the doc itself
// changing. Accept parses the content + inserts it at the top-level
// sibling slot after the anchor and removes the mark; reject just
// removes the mark (the content was never in the PM tree).
//
// Why this anchor-on-existing-text model (proof-sdk pattern):
// - proof-server reconciles every Yjs update against its own markdown
//   projection. Inserting new blocks into the PM tree directly (the
//   model we briefly tried in Phase 1) reads as drift to the server
//   and gets reverted within ~50ms of the accept dispatch. Keeping
//   the candidate content in Y.Map and only adding a mark to existing
//   text matches the proof-sdk ops/suggestion.add contract — the
//   server sees a metadata change, no doc drift, no revert.
// - The ghost widget gives back the in-context preview UX. Server
//   never sees the widget (it's a client-only Decoration, not a PM
//   node), so we get Cursor-style inline preview with proof-sdk
//   compatibility.
//
// Application is lazy: marks materialize when the user navigates to
// the target wiki page, driven by useApplyPendingMarks. Log entries
// follow the same lazy pattern — they queue at ingest time and land
// in wiki:log the next time that page becomes active.

import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import { resolveQuoteRange } from '../editor/utils/textRange'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'
import type { StoredMark } from '@/hooks/useCollabDoc'

const AGENT_ID = 'ai:wiki-ingest'

/** Detect whether a mark for this proposal already lives in the doc.
 * Skips re-stamping when a fresh page mount or Yjs sync replay would
 * otherwise duplicate the same anchor mark. Checks both proofSuggestion
 * (pending) and proofProvenance (post-accept) so an accepted-then-
 * revisited page doesn't undo the user's accept by stamping fresh. */
function hasMarkForProposal(doc: Node, proposalId: string): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if (
        (m.type.name === 'proofSuggestion' || m.type.name === 'proofProvenance') &&
        m.attrs.id === proposalId
      ) {
        found = true
        return false
      }
    }
  })
  return found
}

/** Find the wiki:* doc for a given type id. */
function knownByType(type: string): KnownDoc | null {
  return (
    useDocsStore
      .getState()
      .knownDocs.find((d) => d.type === type && !d.archivedAt) ?? null
  )
}

/** Append a paragraph of plain text to the active editor's doc via a
 * ProseMirror transaction. Used as ensureAnchor placeholder seed and
 * as the log-entry append. PM transactions go through the server's
 * projection guardrails cleanly; raw XmlFragment inserts don't. */
function appendParagraphViaTransaction(view: EditorView, line: string): void {
  const schema = view.state.schema
  const paragraph = schema.nodes.paragraph
  if (!paragraph) {
    console.warn('[ingest] schema has no paragraph node; skipping append')
    return
  }
  const textNode = line.length > 0 ? schema.text(line) : null
  const para = textNode ? paragraph.create(null, textNode) : paragraph.create()
  const end = view.state.doc.content.size
  view.dispatch(view.state.tr.insert(end, para))
}

/** Drain queued log entries into wiki:log. */
export function applyPendingLogsForView(view: EditorView): number {
  const logs = useIngestStore.getState().pendingLogs
  if (logs.length === 0) return 0
  for (const entry of logs) {
    appendParagraphViaTransaction(view, entry.line)
  }
  useIngestStore
    .getState()
    .remove({ proposalIds: [], logIds: logs.map((l) => l.id) })
  return logs.length
}

/** Ensure a wiki page has at least one paragraph of text so the first
 * proofSuggestion mark has a word to anchor on. Empty / ZWS-only docs
 * get the page's title as a seed paragraph; non-empty docs are
 * untouched. The seed write goes through PM transaction so the
 * server's projection guardrails accept it. */
function ensureAnchorViaTransaction(view: EditorView, label: string): void {
  const text = view.state.doc.textBetween(
    0,
    view.state.doc.content.size,
    '\n',
    ' ',
  )
  const cleaned = text.replace(/[​]/g, '').trim()
  if (cleaned.length > 0) return
  appendParagraphViaTransaction(view, label)
}

/** Last non-empty word in the live PM doc, or null if the doc has no
 * text. Used as the proofSuggestion mark's anchor — picking a single
 * word (not the whole last paragraph) keeps the visual decoration to
 * a small, intentional region. */
function lastWordAnchor(view: EditorView): string | null {
  const text = view.state.doc.textBetween(
    0,
    view.state.doc.content.size,
    '\n',
    ' ',
  )
  const cleaned = text.replace(/[​]/g, '').trimEnd()
  if (!cleaned) return null
  const match = cleaned.match(/\S+$/)
  return match ? match[0] : null
}

/** Default anchor label for a wiki page's first-ever placeholder.
 * Uses the page's known title (or a stripped-type fallback) so the
 * heading reads as the page's name when the doc is otherwise empty. */
function defaultAnchorLabel(known: KnownDoc): string {
  const live = known.title?.trim()
  if (live) return live.charAt(0).toUpperCase() + live.slice(1)
  const stripped = known.type.replace(/^wiki:/, '').replace(/^custom-\w+$/, 'Notes')
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

/** Stamp one queued proposal as a proofSuggestion mark on the doc's
 * last word and store its content in Y.Map. Single source of truth for
 * "what this suggestion proposes" is Y.Map<StoredMark>('marks'); the
 * inline mark is a thin anchor (id / kind / by) that markDecoPlugin
 * uses to position the ghost preview widget.
 *
 * Why anchor on the last word: ingest proposals don't have a natural
 * insertion point in the existing page (the page may be empty, or the
 * proposal is unrelated to any specific line). The last word is a
 * stable, always-resolvable anchor; the ghost widget renders the
 * candidate content in the top-level sibling slot right after the
 * anchor's containing block, so the user sees the proposal at the end
 * of the page where it would land on accept.
 *
 * Idempotency: if the doc already has a mark with this proposal.id
 * (pending or accepted-as-provenance), skip. Page remount or Yjs sync
 * replay can otherwise re-run the materializer on the same proposal. */
function applyOneAsMark(
  view: EditorView,
  ydoc: Y.Doc,
  proposal: PendingProposal,
): { ok: true; markId: string } | { ok: false; reason: string } {
  if (hasMarkForProposal(view.state.doc, proposal.id)) {
    return { ok: true, markId: proposal.id }
  }

  const anchor = lastWordAnchor(view)
  if (!anchor) return { ok: false, reason: 'no_anchor' }

  const range = resolveQuoteRange(view.state.doc, anchor)
  if (!range) return { ok: false, reason: 'anchor_not_found' }

  const suggestionType = view.state.schema.marks.proofSuggestion
  if (!suggestionType) return { ok: false, reason: 'schema_proof_suggestion_missing' }

  // Y.Map first — the candidate content + provenance live here, the
  // canonical store readers (markDecoPlugin's ghost widget, popover,
  // accept handler) all consult. Writing first means the addMark
  // dispatch below triggers a deco rebuild that already finds the
  // metadata in place; reversing the order would race the ghost
  // render against the metadata write.
  //
  // Wrap both writes in one Yjs transaction with the 'mark-action'
  // origin so Cmd+Z restores the proposal's PM mark and Y.Map entry
  // as a single undo step — matching accept/reject in markActions.ts.
  // Without this, Cmd+Z would only undo the PM half and a re-attempt
  // would hit an empty Y.Map (the same divergence we hit before
  // labelling accept/reject).
  const marksMap = ydoc.getMap<StoredMark>('marks')
  ydoc.transact(() => {
    marksMap.set(proposal.id, {
      kind: 'insert',
      by: AGENT_ID,
      quote: anchor,
      content: proposal.content,
      status: 'pending',
      at: new Date().toISOString(),
      sourceSlug: proposal.sourceSlug,
      sourceLabel: proposal.sourceLabel,
      sourceQuote: proposal.sourceQuote,
      createdAt: new Date(proposal.proposedAt).toISOString(),
    } as StoredMark)

    // Mark stamp on the anchor range — PM doc itself is unchanged. The
    // server's reconciliation guardrail sees only a metadata-shape
    // update on existing text, treats it as canonical, and doesn't
    // revert (the failure mode that motivated this revert from the
    // PM-tree-insert model).
    view.dispatch(
      view.state.tr.addMark(
        range.from,
        range.to,
        suggestionType.create({
          id: proposal.id,
          kind: 'insert',
          by: AGENT_ID,
        }),
      ),
    )
  }, 'mark-action')

  return { ok: true, markId: proposal.id }
}

/** Apply every queued proposal whose target matches `targetType` to
 * the currently-active editor view. Removes successfully-applied
 * proposals from the queue; failed ones stay queued so the next
 * view-ready cycle can retry. */
export async function applyPendingForActive(
  view: EditorView,
  ydoc: Y.Doc,
  targetType: string,
): Promise<{ applied: string[]; failed: string[] }> {
  const known = knownByType(targetType)
  if (!known) return { applied: [], failed: [] }

  const matching = useIngestStore
    .getState()
    .pendingProposals.filter((p) => p.target === targetType)
  if (matching.length === 0) return { applied: [], failed: [] }

  // First-time anchor seed — empty pages get a "## <PageName>" heading
  // so the first mark has a word to anchor on. Subsequent passes are
  // no-ops because the doc already has content.
  ensureAnchorViaTransaction(view, defaultAnchorLabel(known))
  // Wait one tick so the PM transaction commits and the next read
  // (lastWordAnchor) sees the heading. The first apply otherwise
  // reads a stale empty doc and fails with no_anchor.
  await new Promise<void>((r) => setTimeout(r, 50))

  const applied: string[] = []
  const failed: string[] = []
  for (const p of matching) {
    const out = applyOneAsMark(view, ydoc, p)
    if (out.ok) {
      applied.push(p.id)
      console.log('[ingest:materialize] stamped mark', {
        proposalId: p.id,
        markId: out.markId,
        target: p.target,
      })
    } else {
      failed.push(p.id)
      console.warn('[ingest:materialize] applyOneAsMark failed', {
        proposalId: p.id,
        reason: out.reason,
      })
    }
  }
  if (applied.length > 0) {
    useIngestStore.getState().remove({ proposalIds: applied })
  }
  console.log('[ingest:materialize] done', {
    applied: applied.length,
    failed: failed.length,
  })
  return { applied, failed }
}
