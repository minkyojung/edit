import * as Y from 'yjs'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import type { StoredMark } from '../hooks/useCollabDoc'

const key = new PluginKey<DecorationSet>('markDecoration')

function buildDecos(doc: Node, marksMap: Y.Map<StoredMark>): DecorationSet {
  const decos: Decoration[] = []
  marksMap.forEach((mark, id) => {
    if (!mark.range) return
    const { from, to } = mark.range
    if (from < 0 || to > doc.content.size || from >= to) return
    decos.push(
      Decoration.inline(from, to, {
        class: `mark-deco mark-deco--${mark.kind}`,
        'data-mark-id': id,
      }),
    )
  })
  return DecorationSet.create(doc, decos)
}

export function createMarkDecoPlugin(ydoc: Y.Doc) {
  return $prose(() => {
    const marksMap = ydoc.getMap<StoredMark>('marks')
    let dispatchUpdate: (() => void) | null = null

    const observer = () => dispatchUpdate?.()

    return new Plugin({
      key,
      state: {
        init(_, { doc }) {
          return buildDecos(doc, marksMap)
        },
        apply(tr, decoSet) {
          if (tr.getMeta(key)) return buildDecos(tr.doc, marksMap)
          return decoSet.map(tr.mapping, tr.doc)
        },
      },
      props: {
        decorations(state) {
          return key.getState(state)
        },
      },
      view(view) {
        dispatchUpdate = () => view.dispatch(view.state.tr.setMeta(key, true))
        marksMap.observe(observer)
        // init() runs before Yjs sync so the doc is empty at that point.
        // Rebuild once after the first transaction that brings real content.
        let built = false
        return {
          update(v) {
            if (!built && v.state.doc.content.size > 2) {
              built = true
              dispatchUpdate?.()
            }
          },
          destroy() {
            marksMap.unobserve(observer)
            dispatchUpdate = null
          },
        }
      },
    })
  })
}
