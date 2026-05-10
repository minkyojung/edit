import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface SelectionInfo {
  from: number
  to: number
  text: string
  coords: { top: number; left: number }
  doc: ProseMirrorNode
  view: EditorView
}

export function createSelectionPlugin(onSelect: (info: SelectionInfo | null) => void) {
  return $prose(() => {
    return new Plugin({
      view() {
        return {
          update(view, prevState) {
            const sel = view.state.selection
            const prevSel = prevState.selection
            if (sel.eq(prevSel)) return
            if (sel.empty) {
              onSelect(null)
              return
            }
            const { from, to } = sel
            const doc = view.state.doc
            const text = doc.textBetween(from, to, ' ')
            const coords = view.coordsAtPos(from)
            onSelect({ from, to, text, coords: { top: coords.top, left: coords.left }, doc, view })
          },
          destroy() {
            onSelect(null)
          },
        }
      },
    })
  })
}
