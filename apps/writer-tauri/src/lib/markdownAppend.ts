// Shared "parse this markdown and prepare an append" primitive for
// every site that lands LLM-emitted content into a wiki page.
//
// Two callers used to roll their own variant:
//
//   - applyPendingLogsForView (agent/applyIngest.ts) created a plain
//     `schema.text(line)` paragraph, skipping the markdown parser
//     entirely. That's why `## [2026-05-14] …` rendered as literal
//     hash-hash in the log page: the appender saw markdown but
//     dispatched it as plain text.
//   - acceptProposal (layout/WikiPageBanner.tsx) called the parser
//     correctly and skipped the cleanup (banner targets pages whose
//     ZWS-seed is now removed up-front, so it wasn't visible — but
//     the gap would re-open the moment any consumer regressed).
//
// One helper that does the parse + leading-empty cleanup + append
// position calc, returning a prepared ProseMirror transaction and
// the inserted range. Callers are responsible for `dispatch`:
//   - log drain dispatches directly
//   - banner wraps dispatch in a Yjs transact for atomic Cmd+Z
//     resolution depends on the doc's existing structure)
//
// Returning a *prepared* tr (rather than dispatching inside the
// helper) is what lets banner keep the dispatch inside its
// ydoc.transact wrapper. The wrap is load-bearing — without it,
// the inserted text and its proofAuthored mark would land in
// separate undo entries.

import type { Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useEditorViewStore } from '@/state/editorViewStore'
import { isEffectivelyEmpty } from '@/lib/markdownText'

export interface PreparedMarkdownAppend {
  /** Transaction with leading-empty cleanup (if any) followed by
   * the parsed markdown insert. Caller dispatches — either
   * directly or inside an outer transact wrapper. */
  tr: Transaction
  /** Start position of the inserted content in `tr.doc`. Use to
   * stamp marks (e.g. proofAuthored) on the new range before
   * dispatch. */
  from: number
  /** End position (`from + fragment.size`). */
  to: number
}

/** Parse `markdown` via the globally-mounted Milkdown parser and
 * return a transaction that, when dispatched, appends the result
 * to the end of `view`'s doc — first stripping a leading
 * effectively-empty paragraph if one exists, so the very first
 * append lands at the top rather than below a blank seed.
 *
 * Returns null when the parser isn't ready or the markdown parses
 * to empty content. Caller decides whether to warn-log, toast, or
 * silently skip — this helper stays UX-agnostic. */
export function prepareMarkdownAppend(
  view: EditorView,
  markdown: string,
): PreparedMarkdownAppend | null {
  const parser = useEditorViewStore.getState().parser
  if (!parser) return null
  const parsed = parser(markdown)
  if (!parsed || parsed.content.size === 0) return null
  const fragment = parsed.content

  let tr = view.state.tr
  const doc = view.state.doc
  // Strip a leading effectively-empty paragraph (ZWS seed, BOM, or
  // a stray empty block) so the first real content lands at the
  // top of the page. isEffectivelyEmpty is the shared predicate —
  // matches placeholderPlugin, the wiki context reader, and the
  // ingest source-doc gate, so an invisible-only block is "empty"
  // here whether the server seeded it or the user typed it.
  if (doc.childCount > 0 && isEffectivelyEmpty(doc.child(0).textContent)) {
    tr = tr.delete(0, doc.child(0).nodeSize)
  }
  const insertPos = tr.doc.content.size
  tr.insert(insertPos, fragment)
  return { tr, from: insertPos, to: insertPos + fragment.size }
}
