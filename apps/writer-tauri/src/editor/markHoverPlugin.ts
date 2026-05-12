// Detect hover on inline proof marks (suggestion / authored / comment)
// and route the metadata to two consumers:
//
//   1. MarkHoverActionsLayer — listens for MARK_HOVER_EVENT, renders the
//      floating action bar over proofSuggestion marks. Existing surface,
//      unchanged.
//   2. useEditorFooter store — receives the full hover payload for the
//      status footer at the bottom of the editor area. Replaces the
//      need for a separate popover per mark type.
//
// Mark kinds render distinct DOM:
//
//   proofSuggestion → .mark-deco--{replace|insert|delete} (PM Decoration class)
//                     + .mark-ghost (the multi-line preview widget)
//   proofComment    → .mark-deco--comment (PM Decoration class)
//   proofAuthored   → span[data-proof="authored"] (proof-sdk standard
//                     kind, used for new AI-accepted text). The mark
//                     carries only id + by on its attrs; the wiki-source
//                     / accept-time / model breadcrumb lives in
//                     Y.Map('authoredMeta'), keyed by mark id.
//   proofProvenance → span[data-proof="provenance"] (legacy custom mark
//                     still present on older docs). All breadcrumb
//                     fields ride directly on data-* attrs.
//
// Both authored and provenance emit kind='authored' to the store so the
// footer's hover UX has one path regardless of which inline mark the
// span actually carries.

import * as Y from 'yjs'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { useEditorFooter, type HoveredMark } from '@/stores/editorFooter'
import type { AuthoredMeta } from '../hooks/useCollabDoc'

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
const AUTHORED_SELECTOR = 'span[data-proof="authored"]'
const PROVENANCE_SELECTOR = 'span[data-proof="provenance"]'
const ANY_MARK_SELECTOR =
  `${SUGGESTION_SELECTOR}, ${COMMENT_SELECTOR}, ${AUTHORED_SELECTOR}, ${PROVENANCE_SELECTOR}`

// Distinct internal kinds so extractHover can pick the right data
// source (DOM attrs vs Y.Map lookup); both collapse to 'authored'
// on the HoveredMark we push to the store.
type FoundMarkKind = 'suggestion' | 'comment' | 'authored' | 'provenance'

interface FoundMark {
  el: HTMLElement
  kind: FoundMarkKind
}

function findAnyMarkEl(target: EventTarget | null): FoundMark | null {
  if (!(target instanceof HTMLElement)) return null
  const el = target.closest<HTMLElement>(ANY_MARK_SELECTOR)
  if (!el) return null
  if (el.matches(AUTHORED_SELECTOR)) return { el, kind: 'authored' }
  if (el.matches(PROVENANCE_SELECTOR)) return { el, kind: 'provenance' }
  if (el.matches(COMMENT_SELECTOR)) return { el, kind: 'comment' }
  return { el, kind: 'suggestion' }
}

function extractHover(found: FoundMark, ydoc: Y.Doc): HoveredMark {
  const { el, kind } = found
  const ds = el.dataset
  const markId =
    typeof ds.markId === 'string' && ds.markId.length > 0 ? ds.markId : (ds.id ?? null)

  // proofAuthored carries only id + by on its DOM attrs; the full
  // breadcrumb lives in Y.Map('authoredMeta'), keyed by the same id.
  // Look it up so the footer can render "From X · accepted Y ago ·
  // model Z" the same way it does for the legacy provenance marks.
  const authoredMeta =
    kind === 'authored' && markId
      ? ydoc.getMap<AuthoredMeta>('authoredMeta').get(markId)
      : undefined

  // Footer kind: collapse authored + provenance into a single
  // 'authored' UX kind. The two inline marks are equivalent from the
  // hover viewer's perspective — same breadcrumb, same UI.
  const hoveredKind: HoveredMark['kind'] =
    kind === 'authored' || kind === 'provenance' ? 'authored' : kind

  return {
    kind: hoveredKind,
    id: markId,
    sourceLabel: authoredMeta?.sourceLabel ?? ds.sourceLabel ?? null,
    sourceSlug: authoredMeta?.sourceSlug ?? ds.sourceSlug ?? null,
    acceptedAt: authoredMeta?.acceptedAt ?? ds.acceptedAt ?? null,
    createdAt: authoredMeta?.createdAt ?? ds.createdAt ?? ds.proposedAt ?? null,
    model: authoredMeta?.model ?? ds.model ?? null,
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

export function createMarkHoverPlugin(ydoc: Y.Doc) {
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

              const hover = extractHover(found, ydoc)
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
                const stillHover = extractHover(stillIn, ydoc)
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
