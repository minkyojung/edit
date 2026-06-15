// Floating "Highlight" button for the CodeMirror editor.
//
// Appears above a non-empty selection on a captured note (one with a
// sourceUrl — the read-it-later kind). Clicking it records a highlight via
// cmHighlights; the highlightField repaints the range. State A of the
// highlight menu (the click-to-comment card is state B, CmHighlightNote);
// both wear the shared FLOATING_MENU_SHELL so they read as one surface.

import type { RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { IconHighlight } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { Button } from '@/components/ui/button'
import { FLOATING_MENU_SHELL } from '@/editor/floatingMenuShell'
import { cn } from '@/lib/utils'
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
    <div
      // preventDefault keeps the editor selection alive through the click
      // (otherwise mousedown clears it before onClick reads from/to).
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        FLOATING_MENU_SHELL,
        'fixed z-50 -translate-x-1/2 -translate-y-full',
      )}
      style={{ left: sel.left, top: sel.top - 6 }}
    >
      <Button variant="ghost" size="xs" onClick={onCreate}>
        <IconHighlight size={14} stroke={2} />
        Highlight
      </Button>
    </div>
  )
}
