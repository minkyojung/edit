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

import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useIngestStore, type PendingProposal } from '@/state/ingestStore'
import { applyProposal } from '@/agent/applyProposal'
import type { Proposal } from '@/agent/proposals'

const AGENT_ID = 'ai:wiki-ingest'

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

/** Ensure a wiki page has at least one paragraph of text so the
 * first proofSuggestion mark has somewhere to anchor. Reads the
 * live PM doc — empty (or ZWS-only) means seed; anything else is a
 * no-op. The seed write goes through PM transaction for the same
 * projection-safety reason as logs. */
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

/** Find the last word in the live PM doc to use as a proofSuggestion
 * anchor. We pick a word (not the whole last paragraph) so the mark
 * highlights a small, intentional region — and so the "anchor + new
 * content" replacement on accept reads as an append, not a rewrite.
 * Returns null when the doc has no text at all (caller should run
 * ensureAnchor first). */
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

/** Resolve the proposal's anchor against the live doc. Preferred
 * path: the LLM emitted `anchorAfterText` and that snippet is present
 * in the doc — we anchor on it directly so accept lands the new
 * content right after that line. Fallback: use the doc's last word,
 * which appends to the very end of the page (the previous default).
 *
 * Trim before matching so trivial whitespace differences in the LLM
 * echo don't void the anchor; PM's textBetween normalizes block
 * separators to '\n' so a single leading "- " bullet match still
 * works. The string is consumed by applyProposal as `quote`, which
 * runs its own resolveQuoteRange — so an empty/missing anchor here
 * means "fall back," never "fail." */
function resolveAnchor(
  view: EditorView,
  proposal: PendingProposal,
): string | null {
  const wanted = proposal.anchorAfterText?.trim()
  if (wanted) {
    const docText = view.state.doc
      .textBetween(0, view.state.doc.content.size, '\n', ' ')
      .replace(/[​]/g, '')
    if (docText.includes(wanted)) return wanted
    // LLM-suggested anchor isn't in the doc (rare — typically a tiny
    // whitespace/punctuation drift, or the page changed since ingest
    // ran). Fall through to the page-end fallback rather than
    // failing the apply outright.
  }
  return lastWordAnchor(view)
}

/** Convert one queued ingest proposal into a Proposal shape the
 * existing applyProposal helper accepts, then stamp it as a mark.
 * Anchor comes from `anchorAfterText` when the LLM specified one;
 * otherwise the doc's last word. Content keeps the anchor (so accept
 * = "anchor + new content") and adds the new line on a fresh line. */
function applyOneAsMark(
  view: EditorView,
  ydoc: Y.Doc,
  proposal: PendingProposal,
): { ok: true; markId: string } | { ok: false; reason: string } {
  const anchor = resolveAnchor(view, proposal)
  if (!anchor) return { ok: false, reason: 'no_anchor' }

  const proposalShape: Proposal = {
    kind: 'suggestion',
    suggestionType: 'insert',
    quote: anchor,
    // Just the new content (markdown). Accept will parse this into
    // real heading / list nodes via Milkdown's parser and insert
    // them as block(s) after the anchor's containing block, so the
    // anchor word stays in place and the addition lands on its own
    // line(s) below it.
    content: proposal.content,
    rationale: proposal.rationale,
  }
  const out = applyProposal(view, ydoc, proposalShape, {
    runId: proposal.id,
    agentId: AGENT_ID,
  })
  return out
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
  ydoc: Y.Doc,
  targetType: string,
): Promise<{ applied: string[]; failed: string[] }> {
  const known = knownByType(targetType)
  if (!known) return { applied: [], failed: [] }

  const matching = useIngestStore
    .getState()
    .pendingProposals.filter((p) => p.target === targetType)
  if (matching.length === 0) return { applied: [], failed: [] }

  // First-time anchor seed — empty pages get a "## <PageName>"
  // heading so the first mark has a word to anchor on. Subsequent
  // passes are no-ops because the doc already has content.
  ensureAnchorViaTransaction(view, defaultAnchorLabel(known))
  // Wait one tick so the PM transaction commits and the next read
  // (lastWordAnchor) sees the heading. The first apply otherwise
  // reads a stale empty doc and fails with no_anchor.
  await new Promise<void>((r) => setTimeout(r, 50))

  const applied: string[] = []
  const failed: string[] = []
  for (const p of matching) {
    const out = applyOneAsMark(view, ydoc, p)
    if (out.ok) applied.push(p.id)
    else {
      failed.push(p.id)
      console.warn('[ingest] applyOneAsMark failed', p.id, out.reason)
    }
  }
  if (applied.length > 0) {
    useIngestStore.getState().remove({ proposalIds: applied })
  }
  return { applied, failed }
}

/** Default anchor label for a wiki page's first-ever placeholder.
 * Uses the page's known title (or the type-stripped name as a
 * fallback) so the heading reads as the page's name — "## Beliefs"
 * for wiki:belief, "## People" for a custom 'people' page, etc. */
function defaultAnchorLabel(known: KnownDoc): string {
  const live = known.title?.trim()
  if (live) return live.charAt(0).toUpperCase() + live.slice(1)
  const stripped = known.type.replace(/^wiki:/, '').replace(/^custom-\w+$/, 'Notes')
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}
