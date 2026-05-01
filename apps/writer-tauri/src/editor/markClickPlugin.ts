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
}

export function createMarkClickPlugin() {
  return $prose(
    () =>
      new Plugin({
        key,
        props: {
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos)
            // Resolve position can land on a node boundary — check both sides.
            const candidates = [pos, Math.max(0, pos - 1)]
            for (const p of candidates) {
              const resolved = view.state.doc.resolve(p)
              const marks = resolved.marks()
              for (const m of marks) {
                if (!TRACKED_TYPES.has(m.type.name)) continue
                const id = m.attrs.id
                if (typeof id !== 'string' || id.length === 0) continue
                window.dispatchEvent(
                  new CustomEvent<MarkClickedDetail>(MARK_CLICKED_EVENT, {
                    detail: { markId: id },
                  }),
                )
                return false // don't swallow the click — caret can still land
              }
            }
            void $pos
            return false
          },
        },
      }),
  )
}
