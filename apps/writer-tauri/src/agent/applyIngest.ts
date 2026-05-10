// Apply layer for ingest review — turns queued proposals into
// proofSuggestion marks inside the target wiki page. Each
// proposal becomes one inline mark, anchored on the doc's last
// non-empty word; accepting the mark replaces the anchor with
// "anchor + new content" (= visible append). Reject removes the
// mark, leaving the anchor untouched.
//
// Why marks instead of a separate review modal:
// - Reuses the proof-sdk mark UI (MarkPopoverLayer + MarkPopover)
//   that the rest of the app already uses for AI suggestions, so
//   the user sees one consistent affordance everywhere.
// - Reviewing happens in-context, inside the wiki page itself —
//   the user can see exactly where the addition lands.
// - Karpathy "user reviews what the agent proposed" without
//   building a parallel approve-list dashboard.
//
// Application is lazy: marks materialize when the user navigates
// to the target wiki page, driven by useApplyPendingMarks. Log
// entries follow the same pattern — they queue at ingest time and
// land in wiki:log the next time that page becomes active.
//
// Why every write goes through ProseMirror:
// proof-server keeps two representations of a doc — the y-prosemirror
// XmlFragment and a server-side markdown projection. PM transactions
// are the only path the server's projection guardrails consider
// canonical; raw Y.XmlElement inserts can drift, the server detects
// the drift, and "repairs" by reverting our write (we observed exactly
// this — a paragraph appeared in wiki:log and then vanished a second
// later). So both proposals (via applyProposal) and log lines (via
// tr.insert) write through an EditorView's dispatch.

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'

const AGENT_ID = 'ai:wiki-ingest'

/** Detect whether a mark for this proposal already lives in the doc.
 * Single source of truth: PM tree carries the inserted content with
 * its mark; if scanning the doc finds either the pending proofSuggestion
 * or the post-accept proofProvenance with this id, the proposal has
 * already been materialized (or accepted) on this page. Skip re-stamping
 * so a fresh page-mount or sync replay can't double-insert.
 *
 * Why both mark types: after the user accepts, proofSuggestion transforms
 * to proofProvenance with the same id. Without checking provenance too,
 * an accepted-then-revisited page would re-materialize the same proposal
 * a second time, undoing the user's accept. */
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

/** Find the wiki:* doc for a given type id. Returns null when no
 * such doc exists in the catalog (shouldn't happen — the LLM picks
 * targets from the same catalog the user sees — but handled so a
 * stale proposal can't crash the apply). */
function knownByType(type: string): KnownDoc | null {
  return (
    useDocsStore
      .getState()
      .knownDocs.find((d) => d.type === type && !d.archivedAt) ?? null
  )
}

/** Append a paragraph of plain text to the active editor's doc via a
 * ProseMirror transaction. Used both as the ensureAnchor placeholder
 * seed and as the log-entry append.
 *
 * Why this is safe (where raw XmlFragment inserts aren't): every
 * normal user keystroke flows through PM transactions too, so the
 * server's projection guardrails accept the resulting ydoc updates
 * without flagging drift. The repair pass that erased our raw
 * inserts can't run on PM-shaped writes. */
function appendParagraphViaTransaction(view: EditorView, line: string): void {
  const schema = view.state.schema
  const paragraph = schema.nodes.paragraph
  if (!paragraph) {
    console.warn('[ingest] schema has no paragraph node; skipping append')
    return
  }
  // Build a paragraph node containing one text run. Empty lines fall
  // through as a bare paragraph (PM rejects an empty text node).
  const textNode = line.length > 0 ? schema.text(line) : null
  const para = textNode ? paragraph.create(null, textNode) : paragraph.create()
  const end = view.state.doc.content.size
  view.dispatch(view.state.tr.insert(end, para))
}

/** Drain every queued log entry into wiki:log via PM transactions on
 * its live editor view. Called from useApplyPendingMarks when the
 * user navigates to wiki:log. Logs accumulated since the last visit
 * (one per ingest pass) all land in order. */
export function applyPendingLogsForView(view: EditorView): number {
  const logs = useIngestStore.getState().pendingLogs
  if (logs.length === 0) return 0
  // One transaction per line keeps each entry as its own paragraph
  // (PM batches insertions cleanly, but a fresh tr per line also
  // means a partial failure halfway through still preserves earlier
  // appends).
  for (const entry of logs) {
    appendParagraphViaTransaction(view, entry.line)
  }
  useIngestStore
    .getState()
    .remove({ proposalIds: [], logIds: logs.map((l) => l.id) })
  return logs.length
}

/** Materialize one queued proposal as real PM content + a pending
 * mark. Single source of truth: the proposal's markdown becomes
 * actual heading / list / paragraph nodes inserted at the top of the
 * page, and a `proofSuggestion(insert)` mark wraps the inserted range
 * with id = proposal.id. Accept = transform that mark to provenance
 * (content stays). Reject = delete the marked range (content goes).
 *
 * Why pos 0: ingest proposals don't have a natural anchor in the
 * existing page (the page may be empty, or the proposal is unrelated
 * to any specific line). Inserting at the top puts new content in the
 * user's eye on first scroll, and avoids the pre/post position
 * asymmetry that the old anchor-word model created when the anchor
 * sat inside a blockquote / list / heading wrapper.
 *
 * Idempotency: if a mark with this proposal.id is already in the
 * doc (pending or accepted-as-provenance), skip. A fresh page mount
 * or a Yjs sync replay can otherwise re-run the materializer on the
 * same proposal and double-insert. */
function applyOneAsMark(
  view: EditorView,
  proposal: PendingProposal,
): { ok: true; markId: string } | { ok: false; reason: string } {
  if (hasMarkForProposal(view.state.doc, proposal.id)) {
    return { ok: true, markId: proposal.id }
  }

  const parser = useEditorViewStore.getState().parser
  if (!parser) return { ok: false, reason: 'parser_not_ready' }

  const parsed = parser(proposal.content)
  if (!parsed || parsed.content.size === 0) {
    return { ok: false, reason: 'parser_empty' }
  }

  const suggestionType = view.state.schema.marks.proofSuggestion
  if (!suggestionType) return { ok: false, reason: 'schema_proof_suggestion_missing' }

  // Single transaction: insert the parsed blocks at pos 0, then mark
  // the inserted range with both the suggestion and its provenance
  // breadcrumb. Doing all of it in one tr keeps the user's undo a
  // single step (Cmd+Z removes the entire materialization atomically),
  // prevents the deco plugin from rendering an un-marked-but-inserted
  // intermediate state, and means the breadcrumb metadata rides on
  // the mark itself — no Y.Map.set, no markCleanupPlugin race, and
  // Cmd+Z restores the source* attrs for free along with the mark.
  const fragmentSize = parsed.content.size
  const tr = view.state.tr
    .insert(0, parsed.content)
    .addMark(
      0,
      fragmentSize,
      suggestionType.create({
        id: proposal.id,
        kind: 'insert',
        by: AGENT_ID,
        sourceSlug: proposal.sourceSlug ?? null,
        sourceLabel: proposal.sourceLabel ?? null,
        sourceQuote: proposal.sourceQuote ?? null,
        proposedAt: new Date(proposal.proposedAt).toISOString(),
      }),
    )
  view.dispatch(tr)

  return { ok: true, markId: proposal.id }
}

/** Apply every queued proposal whose target matches `targetType` to
 * the currently-active editor view. Removes successfully-applied
 * proposals from the queue; failed ones (e.g. anchor not found, doc
 * still loading) stay queued so a retry on the next view-ready
 * cycle picks them up.
 *
 * Called from useApplyPendingMarks when both the active slug and
 * its view are ready — so we know `view`/`ydoc` correspond to the
 * doc whose marks we're about to write. */
export async function applyPendingForActive(
  view: EditorView,
  targetType: string,
): Promise<{ applied: string[]; failed: string[] }> {
  if (!knownByType(targetType)) return { applied: [], failed: [] }

  const matching = useIngestStore
    .getState()
    .pendingProposals.filter((p) => p.target === targetType)
  if (matching.length === 0) return { applied: [], failed: [] }

  // No anchor seed needed — proposals are inserted at pos 0 of the
  // page, which is always a valid position regardless of whether the
  // page has prior content. The old anchor-word model required the
  // page to contain at least one word; the new node-insert model
  // doesn't.

  const applied: string[] = []
  const failed: string[] = []
  for (const p of matching) {
    const out = applyOneAsMark(view, p)
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

