// Detect hover on inline proof marks (suggestion / provenance / comment)
// and route the metadata to two consumers:
//
//   1. MarkHoverActionsLayer — listens for MARK_HOVER_EVENT, renders the
//      floating action bar over proofSuggestion marks. Existing surface,
//      unchanged.
//   2. useEditorFooter store — receives the full hover payload for the
//      status footer at the bottom of the editor area. Replaces the
//      need for a separate popover per mark type.
//
// All three mark kinds render distinct DOM:
//
//   proofSuggestion → .mark-deco--{replace|insert|delete} (PM Decoration class)
//                     + .mark-ghost (the multi-line preview widget)
//   proofComment    → .mark-deco--comment (PM Decoration class)
//   proofProvenance → span[data-proof="provenance"] (mark's own toDOM —
//                     no decoration class because we intentionally do not
//                     tint accepted AI text; the DOM attrs are the only
//                     thing the user sees, and only through the footer)

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { useEditorFooter, type HoveredMark } from '@/stores/editorFooter'

const key = new PluginKey('markHoverListener')

export const MARK_HOVER_EVENT = 'writer-tauri:mark-hover'

export interface MarkHoverDetail {
  /** Suggestion mark currently hovered, or null when leaving. Only
   * proofSuggestion marks fire this event — the existing
   * MarkHoverActionsLayer subscribes to it and is scoped to
   * suggestion accept/reject. */
  markId: string | null
}

const SUGGESTION_SELECTOR =
  '.mark-deco--replace, .mark-deco--insert, .mark-deco--delete, .mark-ghost'
const COMMENT_SELECTOR = '.mark-deco--comment'
const PROVENANCE_SELECTOR = 'span[data-proof="provenance"]'
const ANY_MARK_SELECTOR =
  `${SUGGESTION_SELECTOR}, ${COMMENT_SELECTOR}, ${PROVENANCE_SELECTOR}`

interface FoundMark {
  el: HTMLElement
  kind: 'suggestion' | 'comment' | 'provenance'
}

function findAnyMarkEl(target: EventTarget | null): FoundMark | null {
  if (!(target instanceof HTMLElement)) return null
  const el = target.closest<HTMLElement>(ANY_MARK_SELECTOR)
  if (!el) return null
  if (el.matches(PROVENANCE_SELECTOR)) return { el, kind: 'provenance' }
  if (el.matches(COMMENT_SELECTOR)) return { el, kind: 'comment' }
  return { el, kind: 'suggestion' }
}

function extractHover(found: FoundMark): HoveredMark {
  const { el, kind } = found
  const ds = el.dataset
  return {
    kind,
    id: typeof ds.markId === 'string' && ds.markId.length > 0 ? ds.markId : (ds.id ?? null),
    sourceLabel: ds.sourceLabel ?? null,
    sourceSlug: ds.sourceSlug ?? null,
    acceptedAt: ds.acceptedAt ?? null,
    proposedAt: ds.proposedAt ?? null,
    model: ds.model ?? null,
    suggestionType:
      // The decoration class encodes the suggestion kind — pull it out
      // for the footer's "Suggested replace from …" copy.
      el.classList.contains('mark-deco--replace')
        ? 'replace'
        : el.classList.contains('mark-deco--insert')
        ? 'insert'
        : el.classList.contains('mark-deco--delete')
        ? 'delete'
        : null,
    commentText:
      kind === 'comment'
        ? // Comments carry their text on the mark's own data-text attr
          // (set by the comment schema's toDOM). Fall back to the
          // element's text content for older marks that pre-date that
          // attr.
          ds.text ?? el.textContent?.slice(0, 60) ?? null
        : null,
  }
}

function dispatchSuggestion(detail: MarkHoverDetail) {
  window.dispatchEvent(new CustomEvent<MarkHoverDetail>(MARK_HOVER_EVENT, { detail }))
}

export function createMarkHoverPlugin() {
  // Track currently-hovered element at module scope so the cursor
  // moving over neighbouring characters of the SAME mark doesn't
  // produce a storm of redundant store writes / event dispatches.
  let currentKey: string | null = null

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

              const found = findAnyMarkEl(event.target)
              if (!found) return false

              const hover = extractHover(found)
              // Dedup key — for suggestion/comment we have an id; for
              // provenance we use sourceSlug + acceptedAt as a stable
              // composite. Falls back to the element identity itself
              // (its outerHTML's hash would be overkill).
              const dedupKey =
                hover.id ??
                `${found.kind}:${hover.sourceSlug ?? ''}:${hover.acceptedAt ?? ''}`
              if (dedupKey === currentKey) return false
              currentKey = dedupKey

              useEditorFooter.getState().setHovered(hover)
              if (found.kind === 'suggestion' && hover.id) {
                dispatchSuggestion({ markId: hover.id })
              }
              return false
            },
            mouseout(_view, event) {
              const found = findAnyMarkEl(event.target)
              if (!found) return false
              // If the cursor is sliding into another element of the
              // same mark (e.g., suggestion text → its ghost peer, or
              // one wrapped line → the next), suppress the leave so
              // the footer + hover bar don't flicker.
              const related = (event as MouseEvent).relatedTarget
              const stillIn = findAnyMarkEl(related as EventTarget | null)
              if (stillIn) {
                const stillHover = extractHover(stillIn)
                const stillKey =
                  stillHover.id ??
                  `${stillIn.kind}:${stillHover.sourceSlug ?? ''}:${stillHover.acceptedAt ?? ''}`
                if (stillKey === currentKey) return false
              }

              if (currentKey !== null) {
                currentKey = null
                useEditorFooter.getState().setHovered(null)
                // The action layer only cares about suggestion marks
                // leaving — push null only when the departing mark was
                // a suggestion so we don't disrupt any other listener
                // that might rely on this event in the future.
                if (found.kind === 'suggestion') {
                  dispatchSuggestion({ markId: null })
                }
              }
              return false
            },
          },
        },
      }),
  )
}
