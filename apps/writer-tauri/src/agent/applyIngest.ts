// Apply layer for ingest — drains queued log entries into wiki:log
// when that page is active.
//
// Proposal review used to live here too (stamping proofSuggestion
// marks on the last word of the target wiki page, with a ghost
// widget rendering the candidate content). That model is gone —
// proposals are now reviewed via the in-page WikiPageBanner inbox
// (see layout/WikiPageBanner.tsx), which parses + inserts on
// accept without ever creating an inline mark. The five workarounds
// that supported the old surface (lastWordAnchor, empty-page seed
// paragraph, ghost-widget multi-block preview, cross-doc lazy
// materialization, dual PM/Y.Map writes) all went away with it.
//
// What's left is just wiki:log: it remains append-only and there's
// nothing to "review" for log entries — they accrue automatically
// when the user visits the log page. Single function exported.

import type { EditorView } from '@milkdown/kit/prose/view'
import { useIngestStore } from '@/state/ingestStore'

/** Append a paragraph of plain text to the active editor's doc via a
 * ProseMirror transaction. PM transactions go through the server's
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

/** Drain queued log entries into wiki:log. Called from
 * useApplyPendingLogs when the user navigates to the log page. */
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
