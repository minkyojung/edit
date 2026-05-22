// After PM finishes processing a drop that moved a card-type atom
// to a new position, the resulting selection is a NodeSelection on
// the dropped node. Visually that paints the card's
// .ProseMirror-selectednode outline and leaves the cursor "trapped"
// on the card — the user has to press an arrow key before they can
// type a new line.
//
// Inserting a fresh card via the drop/paste plugin already handles
// this by calling `insertBlockAtSelection`, which advances the
// cursor into the trailing paragraph. PM's internal move path bypasses
// that helper because it operates on the raw slice. This plugin
// closes the gap: any post-drop NodeSelection that lands on a
// card-type node is converted to a TextSelection right after the
// node, matching the "image inserted, cursor on the line below"
// behaviour of the insertion path.
//
// Why uiEvent === 'drop' is the trigger: PM tags its drag/drop
// transactions with `uiEvent: 'drop'` so observers can distinguish
// user-initiated drops from programmatic edits. We only want to
// advance the cursor when the user just dropped a card — clicking
// on a card to select it should still leave the NodeSelection in
// place so the user can delete it with Backspace etc.

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'

/** Node types that should auto-advance the cursor after a drop.
 * Phase 2 will add `audioBlock` / `videoBlock` here when those land. */
const CARD_NODE_TYPES = new Set(['imageBlock'])

export const cardDropAdvanceCursor = $prose(
  () =>
    new Plugin({
      appendTransaction(transactions, _oldState, newState) {
        const drop = transactions.find(
          (tr) => tr.getMeta('uiEvent') === 'drop',
        )
        if (!drop) return null
        const sel = newState.selection
        if (!(sel instanceof NodeSelection)) return null
        if (!CARD_NODE_TYPES.has(sel.node.type.name)) return null
        // Move the cursor to the nearest text position after the
        // dropped node. TextSelection.near with direction=1 walks
        // forward, landing inside whatever textblock follows. If
        // the card was dropped at end-of-doc PM has already
        // appended a paragraph, so a valid landing always exists.
        return newState.tr.setSelection(
          TextSelection.near(newState.doc.resolve(sel.to), 1),
        )
      },
    }),
)
