// Cmd-Z / Cmd-Shift-Z router. Accept/Reject from the CHAT PANEL lands an undoable
// entry in the editor's history, but the click leaves focus on the chat button, so
// a plain Cmd-Z never reaches CM. We catch it at the document level and forward to
// the current view's undo/redo — UNLESS focus is in a text-entry element (the editor's
// own contenteditable, the chat composer, any input), which owns its undo. That guard
// also prevents a double-undo when the editor itself is focused (CM's keymap runs).
//
// Extracted from CmEditor's mount effect. `getView` is read on each keystroke so it
// always routes to the CURRENT view (the effect re-creates the view on doc switch).
// Returns a cleanup function that removes the document listener.

import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'

export function installUndoRouter(getView: () => EditorView | null): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    const el = document.activeElement as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    const v = getView()
    if (!v) return
    const did = e.shiftKey ? redo(v) : undo(v)
    if (did) e.preventDefault()
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}
