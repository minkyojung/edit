// Backspace to leave an indented list continuation in one press.
//
// (Top-level marker Backspace used to live here too, but stock `deleteMarkupBackward`
// now handles a column-0 marker cleanly — verified byte-for-byte against its fixtures
// on lang-markdown 6.5.0 — so that guard was removed as a no-op.)

import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { type SyntaxNode } from '@lezer/common'

// A line that starts with a list marker (any indent). Used to bail out of the
// continuation-dedent below — a marker line is deleteMarkupBackward's job.
const ANY_MARKER_RE = /^\s*([-*+]|\d+[.)])[ \t]/

// Backspace at the CONTENT START of an indented, marker-less list continuation (the
// kind Shift+Enter now creates) removes the WHOLE indent in one press, so you leave
// the item cleanly instead of nibbling one space at a time. Scoped so it can't harm
// ordinary text:
//   • caret must sit exactly after the leading indent (content start / end of an
//     all-whitespace line) — mid-content Backspace is the normal delete;
//   • never inside a code block (literal indentation must not change);
//   • a line WITH content only dedents when it is genuinely inside a `ListItem`; an
//     all-whitespace indented line (e.g. a just-made `- x\n  `) always clears, since
//     removing trailing spaces on an empty line is harmless.
// Returns false otherwise → the deleteMarkupBackward / default chain runs unchanged.
// Bind BEFORE deleteMarkupBackward.
export function dedentContinuationBackward(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const ws = /^[ \t]*/.exec(line.text)![0].length
  if (ws === 0) return false // nothing to dedent
  if (sel.head !== line.from + ws) return false // caret must be at the content start
  if (ANY_MARKER_RE.test(line.text)) return false // marker line → not ours

  const allWhitespace = ws === line.text.length
  let inItem = false
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1); n; n = n.parent) {
    if (/Code/.test(n.name)) return false // literal code indentation — keep it
    if (n.name === 'ListItem') {
      inItem = true
      break
    }
  }
  if (!allWhitespace && !inItem) return false // an ordinary indented paragraph → leave it

  view.dispatch({
    changes: { from: line.from, to: line.from + ws, insert: '' },
    selection: { anchor: line.from },
    scrollIntoView: true,
    userEvent: 'delete.dedent',
  })
  return true
}
