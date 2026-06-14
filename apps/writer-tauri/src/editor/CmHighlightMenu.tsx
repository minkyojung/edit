// Floating "Highlight" button for the CodeMirror editor.
//
// Appears above a non-empty selection on a captured note (one with a
// sourceUrl — the read-it-later kind). Clicking it records a highlight via
// cmHighlights; the highlightField repaints the range. This is the CM
// analog of the Milkdown SelectionMenu's highlight action — minimal on
// purpose (no format toolbar), scoped to the read-it-later feature.

import type { RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { useDocsStore } from '@/state/docsStore'
import {
  useCmHighlightSelection,
  createHighlightFromSelection,
} from '@/editor/cmHighlights'

interface Props {
  viewRef: RefObject<EditorView | null>
  slug: string | null
}

export function CmHighlightMenu({ viewRef, slug }: Props) {
  const sel = useCmHighlightSelection((s) => s.sel)
  // Read-it-later only: the note must have been captured from a URL.
  const hasSource = useDocsStore(
    (s) => !!(slug && s.knownDocs.find((d) => d.slug === slug)?.sourceUrl),
  )

  if (!sel || !slug || !hasSource) return null

  const onCreate = () => {
    const v = viewRef.current
    if (v) createHighlightFromSelection(v, slug, sel.from, sel.to)
    useCmHighlightSelection.getState().setSel(null)
  }

  return (
    <button
      type="button"
      // preventDefault keeps the editor selection alive through the click
      // (otherwise mousedown clears it before onClick reads from/to).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onCreate}
      className="fixed z-[60] -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background shadow-md hover:opacity-90"
      style={{ left: sel.left, top: sel.top - 6 }}
    >
      Highlight
    </button>
  )
}
