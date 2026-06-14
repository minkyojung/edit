// CM-native read-it-later highlights — production wiring.
//
// Reuses the proven render core (prototypes/highlights: highlightField +
// the setHighlights effect + offset re-anchor by quote/occurrence) but
// drives it from the REAL source of truth — KnownDoc.highlights via
// lib/highlights — instead of an in-editor record list. The glue here is:
//   1. an initial render extension seeded from the store,
//   2. an effect the CmEditor's store-subscription dispatches to repaint
//      after a create/remove/note change,
//   3. a selection-rect notifier that feeds the floating "Highlight"
//      button, and
//   4. a create helper that records the current selection.
//
// The Milkdown equivalent (useHighlightMarks + highlightClickPlugin) is
// ProseMirror-only; this is its CodeMirror analog so the feature works in
// the CM editor the user actually runs.

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { create } from 'zustand'
import {
  highlights as highlightRender,
  setHighlights,
  occurrenceAt,
} from '@/prototypes/highlights'
import { addHighlightRecord, getHighlights } from '@/lib/highlights'

/** Render extension seeded with the doc's current highlights. Pair it with
 * a store→view sync (see {@link highlightsSyncEffect}) so later edits
 * repaint. */
export function highlightRenderExtension(slug: string): Extension {
  return highlightRender(getHighlights(slug))
}

/** The effect a store subscription dispatches to repaint after a
 * create / remove / note change on `slug`'s highlights. */
export function highlightsSyncEffect(slug: string) {
  return setHighlights.of(getHighlights(slug))
}

// Floating-menu selection state: the current non-empty selection's range +
// viewport anchor, or null. The notifier extension publishes here; the
// CmHighlightMenu popup subscribes. Mirrors the youtubePlayerStore bridge
// pattern — a tiny store decouples a CM extension from a React component.
export interface CmHighlightSel {
  from: number
  to: number
  left: number
  top: number
}
interface SelStore {
  sel: CmHighlightSel | null
  setSel: (s: CmHighlightSel | null) => void
}
export const useCmHighlightSelection = create<SelStore>((set) => ({
  sel: null,
  setSel: (sel) => set({ sel }),
}))

/** Publishes the current selection rect (or null when empty / off-screen)
 * so the floating button can position itself above the selection. */
export const highlightSelectionNotifier: Extension =
  EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged && !u.geometryChanged) return
    const m = u.state.selection.main
    const set = useCmHighlightSelection.getState().setSel
    if (m.empty) {
      set(null)
      return
    }
    const a = u.view.coordsAtPos(m.from)
    if (!a) {
      set(null)
      return
    }
    set({ from: m.from, to: m.to, left: a.left, top: a.top })
  })

/** Record a highlight from a selection range (raw doc offsets). The quote
 * is the exact substring so the offset re-anchor (rangeFor) finds it back
 * across reloads; occurrence disambiguates repeated phrases. */
export function createHighlightFromSelection(
  view: EditorView,
  slug: string,
  from: number,
  to: number,
): void {
  const quote = view.state.sliceDoc(from, to)
  if (!quote.trim()) return
  const occurrence = occurrenceAt(view.state.doc.toString(), quote, from)
  addHighlightRecord(slug, {
    id: crypto.randomUUID(),
    quote,
    occurrence,
    createdAt: new Date().toISOString(),
  })
}
