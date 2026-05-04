// Document title kept in the same Y.Doc as the body so it syncs with
// every other peer for free. Stored as a Y.Text under the well-known
// 'title' key; the body lives elsewhere (Milkdown owns its own
// fragment) so the two streams don't fight.
//
// Returns React-friendly { title, setTitle }. setTitle does a
// transactional replace (delete-all + insert) instead of trying to
// diff — title strings are short, the cost is trivial, and it keeps
// the surface predictable.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'

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
    setLocalTitle(ytext.toString())
    const onChange = () => setLocalTitle(ytext.toString())
    ytext.observe(onChange)
    return () => ytext.unobserve(onChange)
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
