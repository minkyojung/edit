// Clicking an existing highlight SELECTS its text, which surfaces the
// unified SelectionMenu over it (styling buttons act on the highlighted
// text; the note + Remove controls manage the highlight). Modeled on
// wikilinkClickPlugin: a pure ProseMirror plugin that inspects the click
// for a `span[data-highlight]` and, if found, selects the mark's full range.
//
// Returns true (consumes the click) so ProseMirror doesn't override our
// selection with a plain caret.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'

export function createHighlightClickPlugin() {
  return $prose(
    () =>
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const el = (event.target as HTMLElement | null)?.closest(
                'span[data-highlight]',
              ) as HTMLElement | null
              if (!el) return false
              const id = el.getAttribute('data-id')
              if (!id) return false
              const markType = view.state.schema.marks.proofHighlight
              if (!markType) return false

              // Walk the doc for every text node carrying this highlight id,
              // taking the min start / max end as the mark's full range.
              let from = -1
              let to = -1
              view.state.doc.descendants((node, pos) => {
                if (!node.isText) return
                const m = node.marks.find(
                  (mk) => mk.type === markType && mk.attrs.id === id,
                )
                if (m) {
                  if (from < 0) from = pos
                  to = pos + node.nodeSize
                }
              })
              if (from < 0) return false

              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, from, to),
                ),
              )
              view.focus()
              return true
            },
          },
        },
      }),
  )
}
