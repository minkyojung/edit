// Enter inside a heading: split into [heading | paragraph], not two
// headings. ProseMirror's default splitBlock keeps the parent's type,
// so without this Milkdown's commonmark heading turns into a new
// heading on every Enter — which is rarely what users mean. Notion /
// Bear / Obsidian all exit to a paragraph here.
//
// Behavior:
//   - Cursor at end of heading → empty paragraph appears below.
//   - Cursor in the middle    → heading shrinks to "text before
//                                cursor", a paragraph carrying "text
//                                after cursor" appears directly below.
//   - Cursor at start         → empty heading stays, a paragraph
//                                with the original content appears
//                                below. (Cmd+Z restores; the case is
//                                rare enough not to special-case.)
//
// Non-empty selection is left to the default keymap so range
// behaviors (Enter replacing a selection) don't change.

import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Command } from '@milkdown/kit/prose/state'

const splitHeadingToParagraph: Command = (state, dispatch) => {
  const { $head, empty } = state.selection
  if (!empty) return false
  if ($head.parent.type.name !== 'heading') return false

  const paragraphType = state.schema.nodes.paragraph
  if (!paragraphType) return false

  if (dispatch) {
    const heading = $head.parent
    const offset = $head.parentOffset
    const after = heading.content.cut(offset)

    const tr = state.tr
    const headingEndBefore = $head.after()

    // Drop the post-cursor text from the heading. Skipped when the
    // cursor is at the very end (no content to remove).
    if (offset < heading.content.size) {
      tr.delete(state.selection.from, $head.end())
    }

    // Position math after the delete: tr.mapping remaps the original
    // headingEndBefore through the deletion, so we always insert in
    // the slot immediately after the (now-shorter) heading.
    const insertPos = tr.mapping.map(headingEndBefore)
    tr.insert(insertPos, paragraphType.create(null, after))

    // Land the cursor at the start of the new paragraph's content
    // (+1 skips the paragraph's opening token).
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export const headingKeymap = $prose(() =>
  keymap({
    Enter: splitHeadingToParagraph,
  }),
)
