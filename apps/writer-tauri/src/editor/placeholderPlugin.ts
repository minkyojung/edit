// Body placeholder. Marks the first block with a `data-placeholder`
// attribute so CSS can render muted hint text via ::before. The hint
// disappears the moment that block gets real content.
//
// Shown only when the entire body content is a single empty
// paragraph. The paragraph guard matters because container nodes
// (ordered_list, bullet_list, task_list, blockquote, code_block)
// render their own chrome (markers, checkboxes, bars, code
// background) at the same coordinates the placeholder would paint —
// without the guard the hint visually collides with that chrome the
// moment the user types "1. ", "- ", "[ ] ", "> ", or "```".
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
  /** Hint shown when the body is a single empty paragraph. */
  bodyText: string
}

export function createPlaceholderPlugin(opts: PlaceholderOptions) {
  return $prose(
    () =>
      new Plugin({
        key: placeholderKey,
        props: {
          decorations(state: EditorState) {
            const { doc } = state
            if (doc.childCount !== 1) return null
            const first = doc.firstChild
            if (!first) return null
            if (first.type.name !== 'paragraph') return null
            // Emptiness test: structural content size, not textContent.
            // A paragraph that holds only an inline atom (image, hr,
            // future embed types) has `textContent === ''` but
            // `content.size > 0` — without this distinction the
            // placeholder hint would still paint at the start of the
            // paragraph and collide with the image. Matches the
            // standard PM-ecosystem pattern (Tiptap, etc.).
            if (first.content.size !== 0) return null
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, {
                [PLACEHOLDER_ATTR]: opts.bodyText,
              }),
            ])
          },
        },
      }),
  )
}
