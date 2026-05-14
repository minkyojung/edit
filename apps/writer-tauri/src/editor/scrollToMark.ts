// Centers a propose_change / proof_comment mark in the viewport so the
// user can jump from the chat panel to the exact spot in the doc the
// model is talking about. Selection caret is parked at the mark's
// start; PM's tr.scrollIntoView handles the scroll itself.

import type { EditorView } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'

import { findInlineAnchor } from './markActions'

export function scrollToMark(view: EditorView, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId)
  if (!anchor) return false
  const tr = view.state.tr
    .setSelection(TextSelection.create(view.state.doc, anchor.from))
    .scrollIntoView()
  view.dispatch(tr)
  view.focus()
  return true
}
