import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { StoredMark } from './useCollabDoc'

export function useMarks(ydoc: Y.Doc | null): Record<string, StoredMark> {
  const [marks, setMarks] = useState<Record<string, StoredMark>>({})

  useEffect(() => {
    if (!ydoc) return
    const marksMap = ydoc.getMap<StoredMark>('marks')
    const sync = () => {
      const entries: Record<string, StoredMark> = {}
      marksMap.forEach((v, k) => { if (v != null) entries[k] = v })
      setMarks(entries)
    }
    sync()
    marksMap.observe(sync)
    return () => marksMap.unobserve(sync)
  }, [ydoc])

  return marks
}
