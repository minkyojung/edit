// Live title of a doc, read from the body's first level-1 heading.
//
// Post Stage-2 of the title fold, the body is the single source of
// truth for the title — the legacy Y.Text('title') side channel is
// emptied by the migration and never written to again. This hook
// therefore reads only the body fragment. Cmd+Z, collab sync, and
// the proof-sdk pattern all work through the same plumbing as every
// other piece of editable content; no second observer is required.
//
// Callers that need to update the title just edit the h1 in the
// editor body — there is no setter on this hook.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { readH1TitleFromFragment } from '@/lib/docTitle'

export function useDocTitle(ydoc: Y.Doc | null): string {
  const [title, setLocalTitle] = useState('')

  useEffect(() => {
    if (!ydoc) {
      setLocalTitle('')
      return
    }
    const fragment = ydoc.getXmlFragment('prosemirror')
    const compute = () => readH1TitleFromFragment(fragment)
    setLocalTitle(compute())
    const onChange = () => setLocalTitle(compute())
    // observeDeep so edits inside the heading's text children fire
    // even when the fragment's top-level structure is unchanged.
    fragment.observeDeep(onChange)
    return () => {
      fragment.unobserveDeep(onChange)
    }
  }, [ydoc])

  return title
}
