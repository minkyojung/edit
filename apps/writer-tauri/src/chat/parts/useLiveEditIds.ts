import { useMemo } from 'react'
import type { MessagePart } from '@/chat/types'
import { isProposeEditTool } from '@/chat/parts/proposeChangeTool'
import { usePendingChangesStore } from '@/state/pendingChangesStore'

// Separator for the subscription key. NUL can't occur in a crypto.randomUUID
// pendingId, so no two id sets can collide on one key.
const SEP = '\u0000'

/**
 * The pendingIds of `parts` whose proposal is currently live in the store.
 *
 * Subscribes to *these* ids rather than to the whole proposal map. The map
 * changes whenever any proposal anywhere lands or is decided, and a re-render
 * here re-parses this message's entire answer — react-markdown memoizes
 * nothing and its parse is linear in length. Measured against the real
 * pipeline, a thread of 50 settled messages costs 261ms (4KB each) to 606ms
 * (10KB each) in one synchronous commit, so a map-wide subscription makes the
 * cost of clicking Accept scale with how long the conversation is.
 *
 * The selector returns a joined string so plain `Object.is` settles it — a Set
 * or array would be a fresh reference every store write and defeat the point.
 */
export function useLiveEditIds(parts: MessagePart[]): ReadonlySet<string> {
  const ids = useMemo(() => {
    const out: string[] = []
    for (const p of parts) {
      if (p.type !== 'tool' || !isProposeEditTool(p.toolName)) continue
      if (p.pendingId) out.push(p.pendingId)
    }
    return out
  }, [parts])

  const liveKey = usePendingChangesStore((s) =>
    ids.filter((id) => s.byId[id]).join(SEP),
  )

  return useMemo(
    () => new Set(liveKey ? liveKey.split(SEP) : []),
    [liveKey],
  )
}
