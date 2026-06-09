// Inline-format keyboard shortcuts (⌘B/⌘I/⌘E/⌘⇧X wrap-toggles, ⌘K link).
//
// No CM6/Obsidian package ships these (@codemirror/commands has only CODE comment
// toggles; @codemirror/lang-markdown has none), so this is the canonical build:
// one `toggleWrap(marker)` factory over `state.changeByRange` (→ one transaction =
// one undo, multi-cursor + auto position-mapping), with TEXT-based wrap detection
// (robust where the syntax tree refuses to parse `** bold **` / mid-typing),
// inward whitespace trim (markers must hug non-space), word-expansion on a
// collapsed caret, and content-stays-selected so a second press un-toggles.

import { keymap, type Command } from '@codemirror/view'
import { EditorSelection, Prec, type Extension } from '@codemirror/state'

const isSpace = (c: string) => c === '' || /\s/.test(c)

function toggleWrap(marker: string): Command {
  const L = marker.length
  return (view) => {
    const { state } = view
    const tr = state.changeByRange((range) => {
      let { from, to } = range

      // Collapsed caret → wrap the word it touches; on whitespace insert an empty
      // pair with the caret in the middle (ready to type).
      if (from === to) {
        const word = state.wordAt(from)
        if (word && word.from < word.to) {
          from = word.from
          to = word.to
        } else {
          return { changes: { from, insert: marker + marker }, range: EditorSelection.cursor(from + L) }
        }
      }

      // Trim whitespace inward — `** bold **` is invalid; wrap only the core.
      while (from < to && isSpace(state.sliceDoc(from, from + 1))) from++
      while (to > from && isSpace(state.sliceDoc(to - 1, to))) to--
      if (from === to) return { range }

      // Already wrapped? (text-based; for italic `*` make sure we didn't read one
      // star of a `**` pair). Wrapped → remove both markers; else add them.
      const before = state.sliceDoc(from - L, from)
      const after = state.sliceDoc(to, to + L)
      const italicOk =
        marker !== '*' || (state.sliceDoc(from - L - 1, from - L) !== '*' && state.sliceDoc(to + L, to + L + 1) !== '*')
      if (before === marker && after === marker && italicOk) {
        return {
          changes: [
            { from: from - L, to: from },
            { from: to, to: to + L },
          ],
          range: EditorSelection.range(from - L, to - L),
        }
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + L, to + L),
      }
    })
    view.dispatch({ ...tr, userEvent: 'input.format', scrollIntoView: true })
    return true
  }
}

// ⌘K — not a symmetric toggle. Selection → `[text](|)` caret in the URL parens;
// collapsed → `[|]()` caret in the brackets (type the link text first).
const toggleLink: Command = (view) => {
  const { state } = view
  const tr = state.changeByRange((range) => {
    if (range.empty) {
      return { changes: { from: range.from, insert: '[]()' }, range: EditorSelection.cursor(range.from + 1) }
    }
    const text = state.sliceDoc(range.from, range.to)
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}]()` },
      range: EditorSelection.cursor(range.from + 1 + text.length + 2), // inside ()
    }
  })
  view.dispatch({ ...tr, userEvent: 'input.format.link', scrollIntoView: true })
  return true
}

export const inlineFormatKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Mod-b', run: toggleWrap('**') },
    { key: 'Mod-i', run: toggleWrap('*') },
    { key: 'Mod-e', run: toggleWrap('`') },
    { key: 'Mod-Shift-x', run: toggleWrap('~~') },
    { key: 'Mod-k', run: toggleLink },
  ]),
)

// exported for tests
export const _toggleWrap = toggleWrap
export const _toggleLink = toggleLink
