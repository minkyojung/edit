// General link open (migration). Cmd/Ctrl-click a `[text](url)` → open the URL
// (real app: system browser via Tauri opener; prototype: a toast). Plain click
// stays cursor placement — matching the existing linkClickPlugin (Cmd-click to
// open). Wikilinks (`[[..]]` / `note:` scheme) are handled by wikilinkNav, so
// they're skipped here. Same pos→target pattern as wikilinkNav.

import { EditorView } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'

/** The markdown-link URL at `pos`, or null. Skips `note:` targets (those are
 * wikilinks, handled elsewhere). */
export function linkAtPos(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index
    const to = from + m[0].length
    if (pos >= from && pos <= to) {
      const url = m[2]
      return url.startsWith('note:') ? null : url
    }
  }
  return null
}

/** Cmd/Ctrl-click a link → onOpen(url). Plain click is left alone (cursor). */
export function linkClick(onOpen: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false
      // Gate on the clicked `.cm-link` element — posAtCoords alone clamps an off-text
      // click to the nearest position, so empty line space could open a link. The URL
      // is then read from the document at that position.
      if (!(event.target as HTMLElement | null)?.closest?.('.cm-link')) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const url = linkAtPos(view.state, pos)
      if (!url) return false
      event.preventDefault()
      onOpen(url)
      return true
    },
  })
}
