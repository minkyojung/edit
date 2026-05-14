// Apply layer for ingest — drains queued log entries into wiki:log
// and queued index summaries into wiki:index when those pages are
// active.
//
// Proposal review used to live here too (stamping proofSuggestion
// marks on the last word of the target wiki page, with a ghost
// widget rendering the candidate content). That model is gone —
// proposals are now reviewed via the in-page WikiPageBanner inbox
// (see layout/WikiPageBanner.tsx), which parses + inserts on
// accept without ever creating an inline mark.
//
// wiki:log is append-only; wiki:index is line-by-line dedup-merge
// keyed on `target` (Karpathy's index.md pattern). Two drains live
// here so the apply-on-active hook (useApplyPendingLogs,
// useApplyPendingIndexUpdates) can call into them without knowing
// the merge semantics.

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore, type PendingIndexUpdate } from '@/state/ingestStore'
import { isEffectivelyEmpty } from '@/lib/markdownText'
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

/** Format one index line. Format:
 *
 *   `[wiki:custom-XXX] **Title** — summary`
 *
 * `[type-id]` at the start is the dedup key (substring match —
 * cheaper than parsing the line back out). The bold title gives
 * the user something readable to scan; the summary follows after
 * the em-dash. Title comes from knownDocs at apply time, so a page
 * rename naturally flows through on the next index pass.
 *
 * Pure function — caller wraps the result with parser() to get a
 * PM paragraph node. */
function formatIndexLine(target: string, title: string, summary: string): string {
  return `[${target}] **${title}** — ${summary}`
}

/** Find a top-level block in the doc whose text contains the given
 * target marker (`[wiki:custom-XXX]`). Used by the index merge to
 * locate an existing summary line for in-place replacement. Returns
 * { from, to } of the block's range (covering its full nodeSize so
 * the replaceWith below substitutes the entire paragraph). Null
 * when no existing line matches the target. */
function findIndexLineForTarget(
  doc: PMNode,
  target: string,
): { from: number; to: number } | null {
  const marker = `[${target}]`
  let pos = 0
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i)
    if (child.textContent.includes(marker)) {
      return { from: pos, to: pos + child.nodeSize }
    }
    pos += child.nodeSize
  }
  return null
}

/** Resolve a proposal target (wiki:* type id) to its display title
 * via the docs catalog. Falls back to the type-id minus the
 * `wiki:` prefix when the catalog entry is missing or has no
 * title — better to render a stripped id than crash on missing
 * data. */
function titleForTarget(target: string): string {
  const known = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === target && !d.archivedAt)
  const t = known?.title?.trim()
  if (t) return t
  return target.replace(/^wiki:/, '')
}

/** Drain queued index summary updates into wiki:index. Called from
 * useApplyPendingIndexUpdates when the user navigates to the index
 * page. Each update either replaces an existing line for the same
 * target (in-place edit) or appends a new line at the end. The
 * doc-wide ZWS placeholder body that proof-server seeds on first
 * createDoc is stripped on the first append so the page starts
 * clean — without this the index would render with a leading
 * invisible character before any real content. */
export function applyPendingIndexUpdatesForView(view: EditorView): number {
  const updates = useIngestStore.getState().pendingIndexUpdates
  if (updates.length === 0) return 0
  const parser = useEditorViewStore.getState().parser
  if (!parser) {
    console.warn('[ingest:index] parser not ready; skipping drain')
    return 0
  }
  const applied: string[] = []
  for (const u of updates) {
    if (!applyOneIndexUpdate(view, u, parser)) continue
    applied.push(u.id)
  }
  if (applied.length > 0) {
    useIngestStore.getState().remove({ proposalIds: [], indexUpdateIds: applied })
  }
  return applied.length
}

/** Apply one index update — either replace the matching line or
 * append at the end of the doc. Returns true on success so the
 * caller can mark this update as drained; false leaves it in the
 * queue for the next pass.
 *
 * Append path runs through prepareMarkdownAppend (the shared
 * helper) so leading-empty cleanup and the parse step stay in
 * lockstep with the log drain and banner accept. Replace path
 * stays inline because it depends on a marker-derived range that
 * the helper has no way to know about. */
function applyOneIndexUpdate(
  view: EditorView,
  update: PendingIndexUpdate,
  parser: (md: string) => PMNode,
): boolean {
  const title = titleForTarget(update.target)
  const line = formatIndexLine(update.target, title, update.summary)
  const existing = findIndexLineForTarget(view.state.doc, update.target)

  if (!existing) {
    const prep = prepareMarkdownAppend(view, line)
    if (!prep) {
      console.warn('[ingest:index] markdown parse failed for line', line)
      return false
    }
    view.dispatch(prep.tr)
    return true
  }

  // Replace path: parse, account for the leading-empty cleanup the
  // shared helper would have done so the marker range stays valid,
  // and replaceWith on the adjusted range. The replace branch is
  // load-bearing for the index's "one summary per target" invariant
  // — without it a re-summary would append a second line for the
  // same target instead of editing the existing one.
  const parsed = parser(line)
  if (!parsed || parsed.content.size === 0) {
    console.warn('[ingest:index] parser returned empty for line', line)
    return false
  }
  const fragment = parsed.content
  let tr = view.state.tr
  let placeholderRemoved = 0
  const doc = view.state.doc
  if (doc.childCount > 0 && isEffectivelyEmpty(doc.child(0).textContent)) {
    tr = tr.delete(0, doc.child(0).nodeSize)
    placeholderRemoved = doc.child(0).nodeSize
  }
  tr.replaceWith(
    existing.from - placeholderRemoved,
    existing.to - placeholderRemoved,
    fragment,
  )
  view.dispatch(tr)
  return true
}
