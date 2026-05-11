// Document title kept in the same Y.Doc as the body. Two sources are
// supported during the in-progress title-fold migration:
//
//   1. Primary: the text of the first level-1 heading in the editor
//      body (Y.XmlFragment). After Stage 2 of the migration runs on
//      a given doc, this is where the title lives — same place as
//      every other piece of editable content, which lets the
//      UndoManager, collab sync, and proof-sdk pattern all cover
//      title edits with no extra plumbing.
//
//   2. Fallback: the legacy Y.Text('title') side channel, used by
//      docs whose body has not yet been migrated to carry an h1. The
//      writer side (setTitle) still targets this Y.Text during
//      Stages 1–2 so existing edit paths keep working; Stage 3 moves
//      the writer to the PM body and Stage 5 drops Y.Text entirely.
//
// Returns React-friendly { title, setTitle }. setTitle does a
// transactional replace on the Y.Text (delete-all + insert) — title
// strings are short, the cost is trivial, and it keeps the surface
// predictable.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { readH1TitleFromFragment } from '@/lib/docTitle'

const TITLE_KEY = 'title'

export function useDocTitle(ydoc: Y.Doc | null): {
  title: string
  setTitle: (next: string) => void
} {
  const [title, setLocalTitle] = useState('')

  useEffect(() => {
    if (!ydoc) {
      setLocalTitle('')
      return
    }
    const ytext = ydoc.getText(TITLE_KEY)
    const fragment = ydoc.getXmlFragment('prosemirror')
    const compute = () => {
      const fromH1 = readH1TitleFromFragment(fragment)
      return fromH1 || ytext.toString()
    }
    setLocalTitle(compute())
    const onChange = () => setLocalTitle(compute())
    ytext.observe(onChange)
    // observeDeep so edits inside the heading's text children fire
    // even when the fragment's top-level structure is unchanged.
    fragment.observeDeep(onChange)
    return () => {
      ytext.unobserve(onChange)
      fragment.unobserveDeep(onChange)
    }
  }, [ydoc])

  const setTitle = (next: string) => {
    if (!ydoc) return
    const ytext = ydoc.getText(TITLE_KEY)
    if (ytext.toString() === next) return
    ydoc.transact(() => {
      ytext.delete(0, ytext.length)
      if (next.length > 0) ytext.insert(0, next)
    })
  }

  return { title, setTitle }
}
