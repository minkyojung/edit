// Task list (GFM `[ ]`) operations. The gfm preset extends commonmark's
// `list_item` with a `checked` attribute (default null = plain item,
// false/true = task) instead of adding a separate node, so "make this
// a task list" boils down to "ensure we're in a list_item with
// checked != null".
//
// Two paths:
//   - already inside a list_item → setNodeMarkup to add `checked: false`
//   - not in a list → wrap + mark in a single transaction, by capturing
//     wrapInList's would-be transaction (pass our own dispatch) and
//     appending the setNodeMarkup step before committing
//
// Single-transaction is load-bearing: it makes Cmd+Z restore the
// original paragraph in one step, sends one Yjs message instead of
// two, and avoids a brief NodeView re-render between "now a bullet"
// and "now a checkbox".

import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

function findEnclosingListItemPos(view: EditorView): number | null {
  const listItem = view.state.schema.nodes.list_item
  if (!listItem) return null
  const $from = view.state.selection.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === listItem) {
      return $from.before(depth)
    }
  }
  return null
}

export function wrapInTaskList(view: EditorView): void {
  const { schema, doc, tr: emptyTr } = view.state
  const bulletList = schema.nodes.bullet_list
  if (!bulletList) return

  // Already in a list_item — flipping the attr is the whole job.
  const existingItemPos = findEnclosingListItemPos(view)
  if (existingItemPos !== null) {
    const node = doc.nodeAt(existingItemPos)
    if (!node) return
    view.dispatch(
      emptyTr.setNodeMarkup(existingItemPos, undefined, {
        ...node.attrs,
        checked: false,
      }),
    )
    return
  }

  // Capture wrapInList's transaction without dispatching, then append
  // the setNodeMarkup so wrap + task-flip land as one step.
  let captured: Transaction | null = null
  const ok = wrapInList(bulletList)(view.state, (tr) => {
    captured = tr
  })
  if (!ok || !captured) return

  // Resolve the new list_item position against the captured doc.
  const tr: Transaction = captured
  const $from = tr.doc.resolve(tr.selection.from)
  let newItemPos: number | null = null
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === schema.nodes.list_item) {
      newItemPos = $from.before(depth)
      break
    }
  }

  if (newItemPos !== null) {
    const newItem = tr.doc.nodeAt(newItemPos)
    if (newItem) {
      tr.setNodeMarkup(newItemPos, undefined, {
        ...newItem.attrs,
        checked: false,
      })
    }
  }

  view.dispatch(tr)
}
