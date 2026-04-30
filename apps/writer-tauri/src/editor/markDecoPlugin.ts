import * as Y from 'yjs'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'
import type { StoredMark } from '../hooks/useCollabDoc'
import { buildTextIndex, mapTextOffsetsToRange, resolveQuoteRange } from './utils/textRange'

const key = new PluginKey<DecorationSet>('markDecoration')

function parseCharRel(rel: string | undefined): number | null {
  if (!rel || !rel.startsWith('char:')) return null
  const n = parseInt(rel.slice(5), 10)
  return Number.isFinite(n) ? n : null
}

function resolveRange(
  doc: Node,
  mark: StoredMark | null | undefined,
): { from: number; to: number } | null {
  if (!mark) return null

  // 1) char-offset anchors (server's coordinate system)
  const startChar = parseCharRel(mark.startRel)
  const endChar = parseCharRel(mark.endRel)
  if (startChar !== null && endChar !== null && startChar < endChar) {
    const index = buildTextIndex(doc)
    if (index) {
      const range = mapTextOffsetsToRange(index, startChar, endChar)
      if (range) return range
    }
  }

  // 2) quote fallback with normalization
  if (mark.quote) return resolveQuoteRange(doc, mark.quote)

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
