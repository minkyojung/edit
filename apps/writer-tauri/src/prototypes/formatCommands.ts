// Inline formatting shortcuts (migration: deferred "C") — no floating toolbar,
// just keyboard. CM markdown ships no toggle commands, so one generic
// toggleWrap covers bold/italic/code/strike; insertLink handles Cmd+K. (The
// highest-value link path — select text, paste a URL → link — is already on
// for free via markdown()'s pasteURLAsLink.)

import { keymap } from '@codemirror/view'
import type { StateCommand, Extension } from '@codemirror/state'

/** Toggle a symmetric inline marker around the selection.
 *   - already wrapped (marker just outside selection) → remove it
 *   - selection present → wrap it
 *   - empty selection → insert marker pair, caret between (type away) */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const { from, to } = state.selection.main
    const len = marker.length
    const before = state.sliceDoc(Math.max(0, from - len), from)
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + len))

    if (before === marker && after === marker) {
      dispatch(
        state.update({
          changes: [
            { from: from - len, to: from },
            { from: to, to: to + len },
          ],
          selection: { anchor: from - len, head: to - len },
        }),
      )
      return true
    }

    if (from === to) {
      dispatch(
        state.update({
          changes: { from, insert: marker + marker },
          selection: { anchor: from + len },
        }),
      )
      return true
    }

    dispatch(
      state.update({
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        selection: { anchor: from + len, head: to + len },
      }),
    )
    return true
  }
}

/** Cmd+K: wrap selection as `[selection]()` with the caret inside `()`; on an
 * empty selection insert `[]()` with the caret inside `[]`. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const { from, to } = state.selection.main
  if (from === to) {
    dispatch(state.update({ changes: { from, insert: '[]()' }, selection: { anchor: from + 1 } }))
    return true
  }
  const sel = state.sliceDoc(from, to)
  const insert = `[${sel}]()`
  dispatch(
    state.update({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length - 1 }, // inside ()
    }),
  )
  return true
}

export const formatKeymap: Extension = keymap.of([
  { key: 'Mod-b', run: toggleWrap('**') },
  { key: 'Mod-i', run: toggleWrap('*') },
  { key: 'Mod-e', run: toggleWrap('`') },
  { key: 'Mod-Shift-x', run: toggleWrap('~~') },
  { key: 'Mod-k', run: insertLink },
])
