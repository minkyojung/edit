// Empty-body placeholder. Marks the first block of an empty
// document with a `data-placeholder` attribute so CSS can render
// muted hint text via ::before. Disappears the moment the user
// types anything.
//
// "Empty" here means: a single block whose textContent is empty,
// AND the block contains no inline content (no children except
// possibly an empty text node). This catches the common cases —
// freshly created notes, daily entries with only a ZWS — while
// leaving real content (a single typed character, a list, a
// heading with text) alone.
//
// Using a decoration rather than a node attribute keeps the
// placeholder out of the persisted Y.Doc state — collab peers see
// nothing, the hint is purely a local rendering concern.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'

const PLACEHOLDER_ATTR = 'data-placeholder'
const placeholderKey = new PluginKey('writer-placeholder')

export interface PlaceholderOptions {
  /** Hint shown when the body is empty. */
  text: string
}

function isEmpty(state: EditorState): boolean {
  const { doc } = state
  if (doc.childCount !== 1) return false
  const first = doc.firstChild
  if (!first) return true
  // Treat a paragraph containing only a zero-width space as empty —
  // we seed daily / writing bodies with ZWS to satisfy proof-server's
  // blank-markdown guard, and the user shouldn't see a real character
  // standing in the way of their first keystroke's hint.
  const text = first.textContent
  if (text.length === 0) return true
  if (text === '​') return true
  return false
}

export function createPlaceholderPlugin(opts: PlaceholderOptions) {
  return $prose(
    () =>
      new Plugin({
        key: placeholderKey,
        props: {
          decorations(state) {
            if (!isEmpty(state)) return null
            const first = state.doc.firstChild
            if (!first) return null
            // Decorate the very first block (position 0) with the
            // placeholder attribute. CSS picks it up via
            // [data-placeholder]::before.
            const deco = Decoration.node(0, first.nodeSize, {
              [PLACEHOLDER_ATTR]: opts.text,
            })
            return DecorationSet.create(state.doc, [deco])
          },
        },
      }),
  )
}
