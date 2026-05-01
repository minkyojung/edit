// Detect clicks on inline proof marks and broadcast a global event so the
// chat panel can scroll to the matching ProposalSnippet card.
//
// The plugin reads the marks at the clicked position; if any of our proof
// marks are present, it dispatches a CustomEvent with the markId. ChatPanel
// listens for this and runs a scrollIntoView + flash on the matching card.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const key = new PluginKey('markClickListener')
const TRACKED_TYPES = new Set(['proofSuggestion', 'proofComment', 'proofFlagged', 'proofApproved'])

export const MARK_CLICKED_EVENT = 'writer-tauri:mark-clicked'

export interface MarkClickedDetail {
  markId: string
  /** DOM rect of the marked range, in viewport coords. */
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }
}

function findMarkRange(doc: import('@milkdown/kit/prose/model').Node, markId: string) {
  let from = -1
  let to = -1
  doc.descendants((node, pos) => {
    if (from !== -1) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if (TRACKED_TYPES.has(m.type.name) && m.attrs.id === markId) {
        from = pos
        to = pos + node.nodeSize
        return false
      }
    }
  })
  return from === -1 ? null : { from, to }
}

export function createMarkClickPlugin() {
  return $prose(
    () =>
      new Plugin({
        key,
        props: {
          handleClick(view, pos) {
            const candidates = [pos, Math.max(0, pos - 1)]
            for (const p of candidates) {
              const resolved = view.state.doc.resolve(p)
              const marks = resolved.marks()
              for (const m of marks) {
                if (!TRACKED_TYPES.has(m.type.name)) continue
                const id = m.attrs.id
                if (typeof id !== 'string' || id.length === 0) continue

                const range = findMarkRange(view.state.doc, id)
                if (!range) return false
                const start = view.coordsAtPos(range.from)
                const end = view.coordsAtPos(range.to)
                const rect = {
                  left: Math.min(start.left, end.left),
                  right: Math.max(start.right, end.right),
                  top: Math.min(start.top, end.top),
                  bottom: Math.max(start.bottom, end.bottom),
                  width: Math.max(start.right, end.right) - Math.min(start.left, end.left),
                  height: Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top),
                }

                window.dispatchEvent(
                  new CustomEvent<MarkClickedDetail>(MARK_CLICKED_EVENT, {
                    detail: { markId: id, rect },
                  }),
                )
                return false
              }
            }
            return false
          },
        },
      }),
  )
}
