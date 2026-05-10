// Enter / Backspace handling for list items — what commonmark + the
// gfm task extension don't cover on their own.
//
// Three gaps in the stock behavior:
//
//   1. Enter inside a task list (`[ ]`) splits with default attrs, so
//      the new line drops the checkbox and becomes a plain bullet.
//      Users expect another empty checkbox.
//
//   2. Enter on an *empty* list item should escape the list (Notion /
//      Bear / Linear convention), not insert another empty item.
//
//   3. Backspace at the start of an empty list item should make that
//      item disappear in place — the line becomes a plain paragraph,
//      the cursor stays at the start of it. PM's default `joinBackward`
//      gets context-dependent here: between sibling items it merges
//      contents into the previous item, which is not what we want.
//      `liftListItem` is unambiguous: strip the wrapping list_item
//      (and the list itself when it was the sole item), leave a
//      paragraph at the same position.

import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import { liftListItem, splitListItem } from '@milkdown/kit/prose/schema-list'
import type { Command } from '@milkdown/kit/prose/state'

const splitOrLiftListItem: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item
  if (!itemType) return false

  const { selection } = state
  if (!selection.empty) return false

  const $from = selection.$from
  let depth = $from.depth
  while (depth > 0 && $from.node(depth).type !== itemType) depth--
  if (depth === 0) return false

  const item = $from.node(depth)

  // Empty item → lift out of the list. liftListItem takes care of
  // collapsing the now-orphan list when the item was the last one.
  if (item.textContent.length === 0) {
    return liftListItem(itemType)(state, dispatch)
  }

  // Non-empty → split, preserving attrs. For task lists we want the
  // next item to be a new unchecked task, not a checked one (matching
  // Notion's behavior — checking propagates by intent, not by Enter).
  const nextAttrs =
    item.attrs.checked != null ? { ...item.attrs, checked: false } : undefined
  return splitListItem(itemType, nextAttrs)(state, dispatch)
}

// Backspace at the start of an empty list_item: lift the item out of
// the list. The cursor stays put — the line just stops being a list
// item.
const liftEmptyListItem: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item
  if (!itemType) return false

  const { selection } = state
  if (!selection.empty) return false

  const $from = selection.$from
  if ($from.parentOffset !== 0) return false
  if ($from.parent.content.size !== 0) return false
  if ($from.depth < 2) return false
  if ($from.node(-1).type !== itemType) return false
  // Only the first child paragraph of the item — for later paragraphs
  // PM's default Backspace already merges within the same item.
  if ($from.index(-1) !== 0) return false

  return liftListItem(itemType)(state, dispatch)
}

export const listKeymap = $prose(() =>
  keymap({
    Enter: splitOrLiftListItem,
    Backspace: liftEmptyListItem,
  }),
)
