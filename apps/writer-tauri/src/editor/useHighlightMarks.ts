// Renders an article's highlight RECORDS as PM `proofHighlight` marks,
// reactively. The records (on the KnownDoc / `.meta.json`) are the source
// of truth; this hook re-anchors each one to the live body and stamps the
// mark. It runs:
//   - on mount (once `pmView` is set, which is after contentReady), so a
//     saved article reopens with its highlights painted, and
//   - whenever the record set changes (create / remove / note edit), so
//     the create / remove handlers only touch records — the mark follows.
//
// Re-anchoring is by quote + occurrence index (findHighlightRange).
// Saved articles are effectively immutable, so this stays stable.

import { useEffect } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { useDocsStore } from '@/state/docsStore'
import { findHighlightRange } from './anchorSearch'

export function useHighlightMarks(view: EditorView | null, slug: string | null): void {
  // Narrow subscription: the highlights array reference only changes when
  // highlights actually change (record patches build a new array; other
  // KnownDoc updates leave it untouched), so unrelated doc edits don't
  // re-stamp.
  const highlights = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug)?.highlights : undefined,
  )

  useEffect(() => {
    if (!view) return
    const markType = view.state.schema.marks.proofHighlight
    if (!markType) return

    const records = highlights ?? []
    let tr = view.state.tr.removeMark(0, view.state.doc.content.size, markType)
    for (const r of records) {
      const range = findHighlightRange(view.state.doc, r.quote, r.occurrence)
      if (range) tr = tr.addMark(range.from, range.to, markType.create({ id: r.id }))
    }
    // Nothing to do (article with no highlights, no stale marks) → don't
    // dispatch an empty transaction. Marks are a non-undoable render of
    // the records, never part of the user's edit history.
    if (tr.steps.length === 0) return
    view.dispatch(tr.setMeta('addToHistory', false))
  }, [view, highlights])
}
