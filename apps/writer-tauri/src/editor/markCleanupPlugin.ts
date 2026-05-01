// Y.Map cleanup follower.
//
// The inline ProseMirror mark is the single source of truth for whether a
// mark exists. Y.Map('marks') just holds metadata. When the user edits the
// doc such that an inline mark disappears (delete, overtype, accept), this
// plugin notices and drops the matching Y.Map entry so the chat panel
// doesn't keep showing a card for a mark that no longer anchors to anything.

import * as Y from 'yjs'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { StoredMark } from '../hooks/useCollabDoc'

const key = new PluginKey('markCleanup')
const TRACKED_TYPES = new Set(['proofSuggestion', 'proofComment', 'proofFlagged', 'proofApproved'])

export function createMarkCleanupPlugin(ydoc: Y.Doc) {
  return $prose(
    () =>
      new Plugin({
        key,
        appendTransaction(trs, _oldState, newState) {
          if (!trs.some((tr) => tr.docChanged)) return null

          const liveIds = new Set<string>()
          newState.doc.descendants((node) => {
            if (!node.isText) return
            for (const m of node.marks) {
              if (!TRACKED_TYPES.has(m.type.name)) continue
              const id = m.attrs.id
              if (typeof id === 'string' && id.length > 0) liveIds.add(id)
            }
          })

          const marksMap = ydoc.getMap<StoredMark>('marks')
          const stale: string[] = []
          marksMap.forEach((_, id) => {
            if (!liveIds.has(id)) stale.push(id)
          })
          if (stale.length === 0) return null

          // Defer the Y.Map mutation so we never modify Yjs inside ProseMirror's
          // appendTransaction (Yjs schedules its own observers; mixing the two
          // can recurse). The cleanup applies on the next tick instead.
          queueMicrotask(() => {
            ydoc.transact(() => {
              for (const id of stale) marksMap.delete(id)
            }, 'mark-cleanup')
          })
          return null
        },
      }),
  )
}
