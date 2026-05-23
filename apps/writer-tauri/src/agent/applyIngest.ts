// Apply layer for ingest — drains queued log entries into wiki:log
// when the user navigates there.
//
// Proposal review used to live here too (stamping proofSuggestion
// marks on the last word of the target wiki page, with a ghost
// widget rendering the candidate content). That model is gone —
// proposals are now reviewed via the in-page WikiPageBanner inbox
// (see layout/WikiPageBanner.tsx), which parses + inserts on
// accept without ever creating an inline mark.
//
// wiki:index drains used to live here too; the system now writes
// that page deterministically from state/wikiIndex.ts on every
// invalidation, so no queue + apply pipeline is needed.

import type { EditorView } from '@milkdown/kit/prose/view'
import { useIngestStore } from '@/state/ingestStore'
import { prepareMarkdownAppend } from '@/lib/markdownAppend'

/** Drain queued log entries into wiki:log. Called from
 * useApplyPendingLogs when the user navigates to the log page.
 * Each entry is a pre-formatted markdown line (`## [DATE] kind |
 * summary`) and goes through the shared markdown-append helper so
 * headings, links, and any other markdown render — they used to
 * land as literal text because the old appender skipped the
 * parser. */
export function applyPendingLogsForView(view: EditorView): number {
  const logs = useIngestStore.getState().pendingLogs
  if (logs.length === 0) return 0
  const applied: string[] = []
  for (const entry of logs) {
    const prep = prepareMarkdownAppend(view, entry.line)
    if (!prep) {
      console.warn('[ingest:log] markdown parse failed; leaving in queue', entry.line)
      continue
    }
    view.dispatch(prep.tr)
    applied.push(entry.id)
  }
  if (applied.length > 0) {
    useIngestStore.getState().remove({ proposalIds: [], logIds: applied })
  }
  return applied.length
}
