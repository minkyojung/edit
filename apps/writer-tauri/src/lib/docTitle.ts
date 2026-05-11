// Read the doc title from the editor body itself — specifically, the
// text of the first level-1 heading in the Y.XmlFragment that backs
// the ProseMirror doc. Used by useDocTitle and the sidebar title
// mirror so every consumer pulls the title from the same logical
// source (the body) rather than the legacy Y.Text('title') side
// channel, which becomes a write-only fallback during the title-fold
// migration and is dropped entirely once every doc has been
// migrated.
//
// Returns '' when there is no first child, the first child is not a
// heading, or the heading is not level 1. Callers fall back to the
// legacy Y.Text in those cases.

import * as Y from 'yjs'

export function readH1TitleFromFragment(fragment: Y.XmlFragment): string {
  const children = fragment.toArray()
  if (children.length === 0) return ''
  const first = children[0]
  if (!(first instanceof Y.XmlElement)) return ''
  if (first.nodeName !== 'heading') return ''
  // y-prosemirror serialises PM node attrs as strings on the Yjs
  // side; the 'level' attr will be '1' (not 1) for a level-1 heading.
  if (first.getAttribute('level') !== '1') return ''
  return collectText(first).trim()
}

function collectText(el: Y.XmlElement): string {
  let s = ''
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      s += child.toString()
    } else if (child instanceof Y.XmlElement) {
      s += collectText(child)
    }
  }
  return s
}
