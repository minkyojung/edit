// Minimal Backspace guard for the table boundary.
//
// A GFM table is terminated by the blank line after it. If the caret is at the
// start of that blank line and you Backspace, the default merge deletes the
// terminating newline → the paragraph below is no longer separated → GFM absorbs
// it as a new table row, and our block table widget then hides it (it VANISHES;
// verified: Table[0,47] grows to [0,69], "MEDIA…" becomes a TableRow).
//
// You cannot delete that blank without the absorption (it's a markdown rule), so
// the safe behaviour is to NOT delete it. This guard intercepts ONLY that exact
// position and instead SELECTS the whole table block (a node-style selection): the
// blank stays (paragraph survives), and a further Backspace deletes the table as a
// unit rather than corrupting the structure. Everything else falls through normally.

import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'
import { type SyntaxNode } from '@lezer/common'

export function tableBackspace(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.from || line.text.trim() !== '' || line.number <= 1) return false
  // A non-blank line directly below would be absorbed; if the next line is blank or
  // absent, deleting this blank is safe → let the normal Backspace handle it.
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null
  if (!next || next.text.trim() === '') return false
  // The line above must end a Table node.
  const prev = state.doc.line(line.number - 1)
  let table: SyntaxNode | null = null
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(prev.to, -1); n; n = n.parent) {
    if (n.name === 'Table') {
      table = n
      break
    }
  }
  if (!table) return false
  // Select the whole table block instead of deleting the blank.
  const from = state.doc.lineAt(table.from).from
  const to = state.doc.lineAt(Math.min(table.to, state.doc.length)).to
  view.dispatch({ selection: EditorSelection.range(from, to), scrollIntoView: true })
  return true
}
