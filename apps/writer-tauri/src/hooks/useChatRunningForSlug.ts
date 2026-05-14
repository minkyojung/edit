// Subscribe to chatRuns and return true while any run is bound to
// `slug`. Used by the tab strip (and any future sidebar surface) to
// swap the doc icon for a dot-matrix spinner so the user can see at
// a glance which docs have AI work in flight — including background
// docs they've switched away from, since chat runs survive doc
// transitions via the pending-proposal queue.
//
// A 300 ms grace gate suppresses the spinner for sub-second runs so
// the icon doesn't briefly flicker on every fast turn. If the run
// ends before 300 ms elapses, the timer is cancelled and the spinner
// never appears.

import { useEffect, useState } from 'react'
import { useChatRuns } from '@/stores/chatRuns'

const SHOW_DELAY_MS = 300

export function useChatRunningForSlug(slug: string | null): boolean {
  const isRunning = useChatRuns((s) => {
    if (!slug) return false
    for (const run of s.runs.values()) {
      if (run.slug === slug) return true
    }
    return false
  })
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!isRunning) {
      setShown(false)
      return
    }
    const t = window.setTimeout(() => setShown(true), SHOW_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [isRunning])
  return shown
}
