// Generic block-atom insertion helper. Used by the slash menu,
// drag-drop / clipboard-paste pipeline (image and video), and any
// future insertion path that needs to drop a block atom and leave
// the cursor on the next line.
//
// Why this exists: PM's `replaceSelectionWith(blockAtom)` places the
// block at the cursor and sets the selection to a NodeSelection on
// the inserted block. Visually that reads as "card is selected,
// cursor gone". Typing in that state replaces the card with text —
// surprising and destructive.
//
// This helper restores the natural "card inserted, cursor on the
// line below" behaviour: after the block goes in, find the next
// textblock (inserting a fresh empty paragraph if none exists at
// end-of-doc), and place a TextSelection at its start.

import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/** Insert `node` (any block atom — imageBlock, videoBlock, divider,
 * etc.) at the current selection and land the text cursor in the
 * textblock immediately following it. */
export function insertBlockAtSelection(view: EditorView, node: PMNode): void {
  let tr = view.state.tr.replaceSelectionWith(node)
  // After replaceSelectionWith for a block atom, selection is a
  // NodeSelection covering the inserted block; `.to` sits right
  // after the block.
  const after = tr.selection.to
  const $after = tr.doc.resolve(after)
  // If end-of-doc was where we landed, there's nothing to put the
  // cursor in — insert an empty paragraph so the cursor has a home.
  if (!$after.nodeAfter || !$after.nodeAfter.isTextblock) {
    const paraType = view.state.schema.nodes.paragraph
    if (paraType) {
      tr = tr.insert(after, paraType.create())
    }
  }
  // Walk forward from the position right after the block to find
  // the nearest valid text position. That lands inside the next
  // paragraph's content.
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1))
  view.dispatch(tr.scrollIntoView())
}
