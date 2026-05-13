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
 * queue for the next pass. */
function applyOneIndexUpdate(
  view: EditorView,
  update: PendingIndexUpdate,
  parser: (md: string) => PMNode,
): boolean {
  const title = titleForTarget(update.target)
  const line = formatIndexLine(update.target, title, update.summary)
  const parsed = parser(line)
  if (!parsed || parsed.content.size === 0) {
    console.warn('[ingest:index] parser returned empty for line', line)
    return false
  }
  // parser() returns a full doc; we want its children (typically a
  // single paragraph). Inserting the whole doc would nest a doc
  // inside a doc — illegal in the schema.
  const fragment = parsed.content

  const doc = view.state.doc
  const existing = findIndexLineForTarget(doc, update.target)

  // Strip leading ZWS-only paragraph the proof-server seeds on
  // create. Without this the very first applied line lands AFTER
  // a blank paragraph, leaving a leading gap that grows weirder
  // when the user views the page. Defensive check: only the *first*
  // child, only when it's a paragraph whose textContent is ZWS or
  // whitespace.
  let cleanupTr = view.state.tr
  let placeholderRemoved = 0
  if (doc.childCount > 0) {
    const first = doc.child(0)
    const cleaned = first.textContent.replace(/[​-‍﻿\s]/g, '')
    if (!cleaned) {
      cleanupTr = cleanupTr.delete(0, first.nodeSize)
      placeholderRemoved = first.nodeSize
    }
  }

  // Re-resolve `existing` against the post-cleanup doc state so the
  // in-place replace points at the right range. After deleting the
  // leading placeholder, every other block shifts left by its size.
  const adjustedExisting = existing
    ? {
        from: existing.from - placeholderRemoved,
        to: existing.to - placeholderRemoved,
      }
    : null
  const docAfterCleanup = cleanupTr.doc
  if (adjustedExisting) {
    cleanupTr.replaceWith(adjustedExisting.from, adjustedExisting.to, fragment)
  } else {
    cleanupTr.insert(docAfterCleanup.content.size, fragment)
  }
  view.dispatch(cleanupTr)
  return true
}
