// Wikilink click-to-navigate (migration #3, follow-on). A CM
// domEventHandler maps a click position to the `[[Title]]` under it and calls
// `onNavigate(title)` — where the real app would route to the note. The
// position→title resolution is a pure function so it's headless-testable; the
// click wiring is the thin DOM shell.

import { EditorView } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'

/** The wikilink title at document position `pos`, or null. Scans the click's
 * line for `[[...]]` spans and returns the one containing `pos`. */
export function wikilinkAtPos(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  const re = /\[\[([^\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index
    const to = from + m[0].length
    if (pos >= from && pos <= to) return m[1]
  }
  return null
}

/** Click a `[[Title]]` → `onNavigate(title)` (and suppress the default caret
 * placement so it reads as a link, not a text click).
 *
 * Hit-test by the clicked DOM ELEMENT, not by `posAtCoords`: the latter clamps an
 * off-text click to the nearest position, so on a line dominated by a wikilink ANY
 * click on the line lands inside the link's range and (wrongly) navigates. The styled
 * title span (`.cm-wikilink`) is the real target — empty line space is a `.cm-line`. */
export function wikilinkClick(onNavigate: (title: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const el = (event.target as HTMLElement | null)?.closest?.('.cm-wikilink')
      const title = el?.textContent?.trim()
      if (!title) return false
      event.preventDefault()
      onNavigate(title)
      return true
    },
  })
}
