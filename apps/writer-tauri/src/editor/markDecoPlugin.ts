import * as Y from 'yjs'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import type { StoredMark } from '../hooks/useCollabDoc'

const key = new PluginKey<DecorationSet>('markDecoration')

// Search for a quote string inside individual text nodes and return PM positions.
function findQuoteRange(doc: Node, quote: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (found || !node.isText || !node.text) return
    const idx = node.text.indexOf(quote)
    if (idx !== -1) {
      found = { from: pos + idx, to: pos + idx + quote.length }
    }
  })
  return found
}

function resolveRange(
  doc: Node,
  mark: StoredMark | null | undefined,
): { from: number; to: number } | null {
  if (!mark) return null
  if (mark.range) {
    const { from, to } = mark.range
    if (from >= 0 && to <= doc.content.size && from < to) return { from, to }
  }
  if (mark.quote) return findQuoteRange(doc, mark.quote)
  return null
}

function buildDecos(doc: Node, marksMap: Y.Map<StoredMark>): DecorationSet {
  const decos: Decoration[] = []
  marksMap.forEach((mark: StoredMark | null | undefined, id) => {
    if (!mark) return
    const range = resolveRange(doc, mark)
    if (!range) return
    decos.push(
      Decoration.inline(range.from, range.to, {
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
          if (tr.getMeta(key) || tr.docChanged) return buildDecos(tr.doc, marksMap)
          return decoSet
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
        return {
          destroy() {
            marksMap.unobserve(observer)
            dispatchUpdate = null
          },
        }
      },
    })
  })
}
