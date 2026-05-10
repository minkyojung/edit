// Detect hover on inline proof-suggestion marks and broadcast which mark
// the cursor is currently over. Position math lives in the React layer
// (Floating-UI driven), so this plugin only carries the markId — it does
// not compute or transmit any rect.
//
// Scope is intentionally narrow: only proofSuggestion marks (replace /
// insert / delete) and their ghost-widget peers participate. Comment /
// flagged / approved marks rely on click → popover.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const key = new PluginKey('markHoverListener')

export const MARK_HOVER_EVENT = 'writer-tauri:mark-hover'

export interface MarkHoverDetail {
  /** Suggestion mark currently hovered, or null when leaving. */
  markId: string | null
}

const SUGGESTION_SELECTOR =
  '.mark-deco--replace, .mark-deco--insert, .mark-deco--delete, .mark-ghost'

function findSuggestionEl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>(SUGGESTION_SELECTOR)
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

              currentId = id
              dispatch({ markId: id })
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
                dispatch({ markId: null })
              }
              return false
            },
          },
        },
      }),
  )
}
