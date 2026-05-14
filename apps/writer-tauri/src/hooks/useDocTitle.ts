// Live label of a doc, read from the body's first non-empty block.
//
// The body is the single source of truth for a doc's name. There is
// no special "title slot" — whatever the user wrote in the first
// non-empty block (heading, paragraph, list item, etc.) is the
// displayed label. See lib/docLabel.ts for the exact rule.
//
// Callers update the label by editing the body in the editor; there
// is no setter on this hook.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { deriveLabel } from '@/lib/docLabel'

export function useDocTitle(ydoc: Y.Doc | null): string {
  const [title, setLocalTitle] = useState('')

  useEffect(() => {
    if (!ydoc) {
      setLocalTitle('')
      return
    }
    const fragment = ydoc.getXmlFragment('prosemirror')
    const compute = () => deriveLabel(fragment)
    setLocalTitle(compute())
    const onChange = () => setLocalTitle(compute())
    // observeDeep so edits inside block children fire even when the
    // fragment's top-level structure is unchanged.
    fragment.observeDeep(onChange)
    return () => {
      fragment.unobserveDeep(onChange)
    }
  }, [ydoc])

  return title
}
