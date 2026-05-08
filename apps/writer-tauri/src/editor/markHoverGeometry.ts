// Geometry helper for the proofSuggestion hover surface.
//
// Single source of truth for "where does this mark END in the viewport?":
// - Multi-line marks (spanning: true) wrap into multiple inline-decoration
//   spans, one per line. The last segment's last client rect is the
//   visual end of the mark.
// - replace / insert kinds also emit a ghost widget that visually extends
//   past the original — that ghost's rect counts as the end.
//
// The plugin uses this to detect hover boundaries; the React layer wraps
// it in a Floating-UI virtual element so the hover bar's position stays
// live across resizes / scrolls / font loads.

import type { EditorView } from '@milkdown/kit/prose/view'

function escapeAttr(value: string): string {
  if (typeof CSS !== 'undefined' && 'escape' in CSS) return CSS.escape(value)
  return value.replace(/"/g, '\\"')
}

/** All DOM elements (inline deco spans + ghost widget) that share a markId. */
export function getMarkElements(view: EditorView, markId: string): HTMLElement[] {
  const escaped = escapeAttr(markId)
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>(`[data-mark-id="${escaped}"]`),
  )
}

/**
 * Viewport rect of the mark's END (last segment's last line). Returns null
 * when the mark has no live elements (e.g. just accepted/rejected, the
 * hover bar should close).
 */
export function getMarkEndRect(view: EditorView, markId: string): DOMRect | null {
  const els = getMarkElements(view, markId)
  if (els.length === 0) return null
  const last = els[els.length - 1]
  const rects = last.getClientRects()
  if (rects.length === 0) return last.getBoundingClientRect()
  return rects[rects.length - 1]
}
