import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const testMarkKey = new PluginKey('test-marks')

export const testMarkPlugin = $prose(() =>
  new Plugin({
    key: testMarkKey,
    props: {
      decorations(state) {
        const docSize = state.doc.content.size
        if (docSize < 4) return DecorationSet.empty
        return DecorationSet.create(state.doc, [
          Decoration.inline(1, 4, {
            style: 'background-color: rgba(234, 179, 8, 0.4);'
          })
        ])
      }
    }
  })
)
