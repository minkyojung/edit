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
import { EditorSelection, Prec, type EditorState, type Extension } from '@codemirror/state'

const isSpace = (c: string) => c === '' || /\s/.test(c)

// Start of a line's CONTENT — past any leading markdown block marker (blockquote
// `>`, list `- `/`1. `/`- [ ] `, heading `# `). Format shortcuts clamp the wrap to
// this so ⌘B bolds the TEXT, not the marker (`- **x**`, never `**- x**`).
function lineContentStart(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  const m = /^(?:[ \t]*(?:>[ \t]*)*)(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/.exec(line.text)
  return line.from + (m ? m[0].length : 0)
}

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

      // Don't swallow the line's leading marker (`- `, `1. `, `> `, `# `, `- [ ] `):
      // pull the start to the content so ⌘B wraps the TEXT, not the marker.
      const cs = lineContentStart(state, from)
      if (from < cs) from = Math.min(cs, to)

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
    const from = Math.min(Math.max(range.from, lineContentStart(state, range.from)), range.to) // skip the marker
    const text = state.sliceDoc(from, range.to)
    return {
      changes: { from, to: range.to, insert: `[${text}]()` },
      range: EditorSelection.cursor(from + 1 + text.length + 2), // inside ()
    }
  })
  view.dispatch({ ...tr, userEvent: 'input.format.link', scrollIntoView: true })
  return true
}

// The wrap toggles (⌘B/⌘I/⌘E/⌘⇧X). ⌘K (link) is kept separate so a host where
// ⌘K is owned by a global shortcut (e.g. the command palette) can omit it.
const wrapBindings = [
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Mod-e', run: toggleWrap('`') },
  { key: 'Mod-Shift-x', run: toggleWrap('~~') },
]

export const inlineFormatKeymap: Extension = Prec.high(
  keymap.of([...wrapBindings, { key: 'Mod-k', run: toggleLink }]),
)

// Variant WITHOUT ⌘K — for CmEditor, where ⌘K opens the command palette
// (a window-level shortcut) and binding link here would double-fire both.
export const inlineFormatKeymapNoLink: Extension = Prec.high(keymap.of(wrapBindings))

// exported for tests
export const _toggleWrap = toggleWrap
export const _toggleLink = toggleLink
