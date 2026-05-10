import * as Y from 'yjs'
import { useMarks } from '@/hooks/useMarks'

/** Header-row badge: "Reviewing…" while the active doc has open
 *  marks. No counts — just a presence signal that there's pending
 *  AI feedback to act on. Disappears when all marks are resolved. */
export function ReviewProgressBadge({ ydoc }: { ydoc: Y.Doc | null }) {
  const marks = useMarks(ydoc)
  if (Object.keys(marks).length === 0) return null
  return (
    <span className="text-xs text-muted-foreground">Reviewing…</span>
  )
}
