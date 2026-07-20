// Top-level list-marker Backspace — clean removal, no leftover spaces.
//
// CM's built-in `deleteMarkupBackward` replaces a list marker with equal-width
// blank space to PRESERVE nested indentation (so deleting a sub-item's marker
// keeps its body aligned under the parent). That's the right call for nested
// lists — but a TOP-LEVEL bullet has no indentation to preserve, so it just
// leaves orphan whitespace ("- " → "  "), which reads as "I deleted the bullet
// but a ghost indent stayed". Especially rough for IME users who hit Backspace a
// lot mid-composition.
//
// We intercept ONLY that one case: the caret sits right after a COLUMN-0 marker
// → delete the whole `marker+gap` so the body lands at column 0. Everything else
// — nested markers, caret mid-content, a `- ` that's literal text inside code —
// returns false, so `deleteMarkupBackward` / the default delete run UNCHANGED and
// CM's nested-indent behaviour is kept intact. Bind BEFORE deleteMarkupBackward.

import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { type SyntaxNode } from '@lezer/common'

// A column-0 (no indent) bullet or ordered marker plus its trailing gap.
const TOP_MARKER_RE = /^([-*+]|\d+[.)])([ \t]+)/

export function clearTopLevelMarkerBackward(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false // a real selection → let default delete it
  const line = state.doc.lineAt(sel.head)
  const m = TOP_MARKER_RE.exec(line.text)
  if (!m) return false
  const prefixEnd = m[0].length
  // The caret must sit EXACTLY after the marker (the spot where CM would replace
  // it with spaces). Mid-content or before-marker → not ours.
  if (sel.head - line.from !== prefixEnd) return false

  // Confirm it's a REAL list marker (lezer `ListMark`), not a `- ` that happens
  // to be literal text inside a fenced/indented code block — there we must not
  // touch it. This is the guard CM gets for free from its syntax-tree context.
  let isListMark = false
  syntaxTree(state).iterate({
    from: line.from,
    to: line.from + prefixEnd,
    enter: (n) => {
      if (n.name === 'ListMark') isListMark = true
    },
  })
  if (!isListMark) return false

  view.dispatch({
    changes: { from: line.from, to: line.from + prefixEnd, insert: '' },
    selection: { anchor: line.from },
    scrollIntoView: true,
    userEvent: 'delete',
  })
  return true
}

// A line that starts with a list marker (any indent). Used to bail out of the
// continuation-dedent below — a marker line is clearTopLevel/deleteMarkup's job.
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
// Bind AFTER clearTopLevelMarkerBackward and BEFORE deleteMarkupBackward.
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
