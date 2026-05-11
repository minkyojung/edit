// Empty-slot placeholders. Marks empty top-level blocks with a
// `data-placeholder` attribute so CSS can render muted hint text
// via ::before. Disappears the moment that slot gets content.
//
// Two slots are supported because of how the body is now structured:
//
//   - Title slot: the first block, but only when it's a level-1
//     heading. Used post title-fold so non-daily docs show
//     "Untitled" on the empty title line. Daily docs don't have a
//     title slot inside the body (the date is rendered outside the
//     editor), so this slot is silently skipped for them.
//
//   - Body slot: the first non-title block. Shown when the body
//     content is a single empty/ZWS block. As soon as the user
//     types anywhere in the body (or adds a second block) the hint
//     disappears.
//
// Either slot decoration is omitted if the caller didn't pass text
// for it, so a caller can opt in to just the body hint.
//
// Using a decoration rather than a node attribute keeps the
// placeholder out of the persisted Y.Doc state — collab peers see
// nothing, the hint is purely a local rendering concern.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

const PLACEHOLDER_ATTR = 'data-placeholder'
const placeholderKey = new PluginKey('writer-placeholder')

export interface PlaceholderOptions {
  /** Hint shown when the body content slot is empty. */
  bodyText: string
  /** Hint shown when the first block is a level-1 heading with no
   * text. Pass undefined for surfaces (like daily entries) that
   * render their title outside the editor. */
  titleText?: string
}

function isNodeEmpty(node: PMNode): boolean {
  const text = node.textContent
  if (text.length === 0) return true
  // ZWS is the proof-server placeholder used to satisfy the
  // non-empty-markdown guard. Treat it as empty so the hint shows
  // until the user's first real keystroke.
  if (text === '​') return true
  return false
}

// Title slot: a level-1 heading at the top of the doc. We tried a
// dedicated `title` node with `isolating: true` at one point but the
// server's collab pipeline didn't recognize the new type and reverted
// every change made inside one — see the revert(title) commit for
// the full story. Keymap guards in headingKeymap.ts now provide the
// "physical separation" we were after, without a schema change.
function isLevel1Heading(node: PMNode): boolean {
  return node.type.name === 'heading' && node.attrs.level === 1
}

export function createPlaceholderPlugin(opts: PlaceholderOptions) {
  return $prose(
    () =>
      new Plugin({
        key: placeholderKey,
        props: {
          decorations(state: EditorState) {
            const { doc } = state
            if (doc.childCount === 0) return null
            const decos: Decoration[] = []

            const first = doc.firstChild
            if (!first) return null

            // Title slot: first block is a level-1 heading.
            let bodyStartIndex = 0
            let bodyStartPos = 0
            if (isLevel1Heading(first)) {
              if (opts.titleText && isNodeEmpty(first)) {
                decos.push(
                  Decoration.node(0, first.nodeSize, {
                    [PLACEHOLDER_ATTR]: opts.titleText,
                  }),
                )
              }
              bodyStartIndex = 1
              bodyStartPos = first.nodeSize
            }

            // Body slot: shown only when the entire body content is a
            // single empty/ZWS paragraph. The paragraph guard matters
            // because container nodes (ordered_list, bullet_list,
            // task_list, blockquote, code_block) render their own
            // chrome (markers, checkboxes, bars, code background) at
            // the same coordinates the placeholder would paint —
            // without the guard the hint visually collides with that
            // chrome the moment the user types "1. ", "- ", "[ ] ",
            // "> ", or "```".
            if (
              doc.childCount === bodyStartIndex + 1 &&
              bodyStartIndex < doc.childCount
            ) {
              const bodyFirst = doc.child(bodyStartIndex)
              if (
                bodyFirst.type.name === 'paragraph' &&
                isNodeEmpty(bodyFirst)
              ) {
                decos.push(
                  Decoration.node(
                    bodyStartPos,
                    bodyStartPos + bodyFirst.nodeSize,
                    { [PLACEHOLDER_ATTR]: opts.bodyText },
                  ),
                )
              }
            }

            if (decos.length === 0) return null
            return DecorationSet.create(doc, decos)
          },
        },
      }),
  )
}
