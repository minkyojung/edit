// Detect hover on inline proof-suggestion marks and broadcast a global
// event so a floating action bar can be anchored at the *end* of the
// suggestion (right after the last character or ghost replacement). Click
// on the mark text itself is no longer used to open a separate rationale
// popover — rationale is now rendered inside the hover bar instead.
//
// Scope is intentionally narrow: only proofSuggestion marks (replace /
// insert / delete) and their ghost-widget peers participate. Comment /
// flagged / approved marks rely on click → popover.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

const key = new PluginKey('markHoverListener')

export const MARK_HOVER_EVENT = 'writer-tauri:mark-hover'

export interface MarkHoverDetail {
  /** Suggestion mark currently hovered, or null when leaving. */
  markId: string | null
  /**
   * Viewport rect of the *last* visual segment of the suggestion (last
   * line for multi-line marks; the ghost replacement for replace/insert).
   * The action bar anchors its left edge to `rect.right` so it sits
   * immediately after the suggestion text.
   */
  rect: {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  } | null
}

const SUGGESTION_SELECTOR =
  '.mark-deco--replace, .mark-deco--insert, .mark-deco--delete, .mark-ghost'

function findSuggestionEl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>(SUGGESTION_SELECTOR)
}

/**
 * Get the rect of the END of a suggestion: walk every DOM node carrying
 * the same `data-mark-id` (original-text spans + ghost widget) and pick
 * the last one's last client rect. This handles:
 *   - multi-line wrapping (each line is a separate rect)
 *   - replace/insert (ghost widget is the visual "end")
 *   - delete (no ghost, end = last rect of red strikethrough)
 */
function getMarkEndRect(view: EditorView, markId: string): DOMRect | null {
  const escaped = (typeof CSS !== 'undefined' && 'escape' in CSS)
    ? CSS.escape(markId)
    : markId.replace(/"/g, '\\"')
  const els = view.dom.querySelectorAll<HTMLElement>(
    `[data-mark-id="${escaped}"]`,
  )
  if (els.length === 0) return null
  const last = els[els.length - 1]
  const rects = last.getClientRects()
  if (rects.length === 0) return last.getBoundingClientRect()
  return rects[rects.length - 1]
}

function dispatch(detail: MarkHoverDetail) {
  window.dispatchEvent(new CustomEvent<MarkHoverDetail>(MARK_HOVER_EVENT, { detail }))
}

export function createMarkHoverPlugin() {
  // Track the currently-hovered markId at module scope of the plugin so we
  // dedupe the storm of mouseover events fired as the cursor moves across
  // characters within the same mark.
  let currentId: string | null = null

  return $prose(
    () =>
      new Plugin({
        key,
        props: {
          handleDOMEvents: {
            mouseover(view, event) {
              // Suppress while the user is selecting — a hovering bar
              // over a drag selection is distracting.
              if (!view.state.selection.empty) return false

              const el = findSuggestionEl(event.target)
              if (!el) return false
              const id = el.dataset.markId
              if (typeof id !== 'string' || id.length === 0) return false
              if (id === currentId) return false

              const endRect = getMarkEndRect(view, id)
              if (!endRect) return false

              currentId = id
              dispatch({
                markId: id,
                rect: {
                  left: endRect.left,
                  top: endRect.top,
                  right: endRect.right,
                  bottom: endRect.bottom,
                  width: endRect.width,
                  height: endRect.height,
                },
              })
              return false
            },
            mouseout(_view, event) {
              const el = findSuggestionEl(event.target)
              if (!el) return false
              // If the cursor is moving to another element belonging to
              // the same mark (text → ghost, or one wrapped line → the
              // next), suppress the leave. The React layer's leave timer
              // handles the eventual close.
              const related = (event as MouseEvent).relatedTarget
              const stillIn = findSuggestionEl(related as EventTarget | null)
              if (stillIn?.dataset.markId === currentId) return false

              if (currentId !== null) {
                currentId = null
                dispatch({ markId: null, rect: null })
              }
              return false
            },
          },
        },
      }),
  )
}
