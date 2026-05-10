// Plugin half of the wikilink autocomplete. Walks every transaction
// to figure out whether the caret is positioned right after a
// `[[query` pattern, and surfaces that state to React via a
// callback. The React side (WikilinkPalette) renders the actual
// popup and is responsible for resolving the query into a slug.
//
// Keyboard interplay:
//   - While active, ArrowUp/Down/Enter/Escape/Tab are routed back to
//     React through `onKey` so the popup can drive its highlight
//     without losing focus from the editor's contenteditable.
//   - All other keystrokes pass through unmodified — typing extends
//     the query, backspace shortens it, anything that breaks the
//     `[[query` pattern (newline, ]]) closes the palette via the
//     state update.
//
// The plugin doesn't insert the wikilink itself; the popup calls
// `commitWikilink(view, range, slug, label)` once the user picks
// something. Keeping insert logic out of here means the schema and
// resolution rules stay in one file (wikilinkSchema + the helper
// below) and the plugin stays a pure detection surface.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface WikilinkPaletteState {
  active: boolean
  /** Document position of the first `[` so we know where to splice
   * when the user picks a target. */
  from: number
  to: number
  /** Text typed after `[[`. May be empty (palette opens the moment
   * the second `[` lands). */
  query: string
}

export interface WikilinkPaletteInfo {
  /** Viewport-anchored caret rect for popup positioning. */
  rect: { left: number; right: number; top: number; bottom: number }
  query: string
  from: number
  to: number
  view: EditorView
}

export type WikilinkPaletteKey = 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape'

interface PluginOptions {
  onChange: (info: WikilinkPaletteInfo | null) => void
  onKey: (key: WikilinkPaletteKey) => boolean
}

export const wikilinkPaletteKey = new PluginKey<WikilinkPaletteState>('wikilinkPalette')

const INACTIVE: WikilinkPaletteState = { active: false, from: 0, to: 0, query: '' }
const PATTERN = /\[\[([^\]\n[]*)$/

export function createWikilinkPalettePlugin({ onChange, onKey }: PluginOptions) {
  return $prose(
    () =>
      new Plugin<WikilinkPaletteState>({
        key: wikilinkPaletteKey,
        state: {
          init: () => INACTIVE,
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(wikilinkPaletteKey) as
              | { type: 'cancel' }
              | undefined
            if (meta?.type === 'cancel') return INACTIVE

            const sel = newState.selection
            if (!sel.empty) return prev.active ? INACTIVE : prev

            const $head = sel.$head
            const parent = $head.parent
            // Only look backwards within the current paragraph; if the
            // caret is outside an inline-allowing block we punt.
            if (!parent.inlineContent) {
              return prev.active ? INACTIVE : prev
            }
            const before = parent.textBetween(
              0,
              $head.parentOffset,
              '\n',
              '\n',
            )
            const m = PATTERN.exec(before)
            if (!m) return prev.active ? INACTIVE : prev

            const matchLen = m[0].length
            return {
              active: true,
              from: $head.pos - matchLen,
              to: $head.pos,
              query: m[1],
            }
          },
        },
        view(view) {
          // Push the initial (likely inactive) state so the React side
          // can mount cleanly.
          notify(view)
          return {
            update(view, prevState) {
              const cur = wikilinkPaletteKey.getState(view.state)
              const prev = wikilinkPaletteKey.getState(prevState)
              if (cur === prev) return
              notify(view)
            },
            destroy() {
              onChange(null)
            },
          }
          function notify(view: EditorView) {
            const state = wikilinkPaletteKey.getState(view.state)
            if (!state || !state.active) {
              onChange(null)
              return
            }
            const coords = view.coordsAtPos(state.to)
            onChange({
              rect: coords,
              query: state.query,
              from: state.from,
              to: state.to,
              view,
            })
          }
        },
        props: {
          handleKeyDown(_view, event) {
            const state = wikilinkPaletteKey.getState(_view.state)
            if (!state?.active) return false
            const key = event.key as WikilinkPaletteKey
            if (
              key === 'ArrowUp' ||
              key === 'ArrowDown' ||
              key === 'Enter' ||
              key === 'Tab' ||
              key === 'Escape'
            ) {
              const handled = onKey(key)
              if (handled) {
                event.preventDefault()
                return true
              }
            }
            return false
          },
        },
      }),
  )
}

/** Replace the `[[query` range with marked text carrying the
 * resolved slug. The label becomes a normal text node so the user
 * can see (and, in v2, edit) the link title; the slug rides on a
 * wikilink mark applied across that text. Used by the palette UI
 * on selection. */
/** Custom href scheme used to mark a regular link mark as an
 * internal wikilink. Round-trips through proof-sdk's headless
 * commonmark schema (which knows the standard link mark) and back
 * without losing the slug, while staying valid markdown for export
 * (`[label](note:slug)`). The click handler intercepts hrefs with
 * this scheme and routes through the docs registry. */
export const WIKILINK_HREF_PREFIX = 'note:'

export function isWikilinkHref(href: string | null | undefined): boolean {
  return !!href && href.startsWith(WIKILINK_HREF_PREFIX)
}

export function slugFromWikilinkHref(href: string): string {
  return href.slice(WIKILINK_HREF_PREFIX.length)
}

export function commitWikilink(
  view: EditorView,
  range: { from: number; to: number },
  slug: string,
  label: string,
): void {
  // Use the standard `link` mark instead of a custom wikilink mark so
  // the round-trip through proof-sdk's collab pipeline preserves it
  // — proof-sdk's headless schema knows commonmark links, not our
  // wikilink. The slug rides on href as `note:{slug}` and the click
  // plugin intercepts that scheme.
  const markType = view.state.schema.marks.link
  if (!markType) return
  const href = WIKILINK_HREF_PREFIX + slug
  // commonmark's link mark is inclusive by default (typing at the
  // right edge of a link extends it). To stop the user's next
  // keystroke from being absorbed into our wikilink, we insert the
  // marked label AND a plain trailing space in the SAME tr. The
  // unmarked space sits between the link and the cursor's next
  // landing spot, so subsequent typing inherits the space's empty
  // mark set instead of the link's. setStoredMarks([]) is belt-and-
  // suspenders for the storedMarks slot, which replaceWith leaves
  // primed with the inserted content's right-edge marks.
  const labelNode = view.state.schema.text(label, [markType.create({ href })])
  const spaceNode = view.state.schema.text(' ')
  const tr = view.state.tr
    .replaceWith(range.from, range.to, [labelNode, spaceNode])
    .setStoredMarks([])
  view.dispatch(tr)
  view.focus()
}

/** Imperative cancel — used by Escape from the palette UI. */
export function cancelWikilink(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(wikilinkPaletteKey, { type: 'cancel' }))
}
