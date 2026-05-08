// Visual decoration for proof-marks.
//
// We derive decorations directly from the inline ProseMirror marks (proof
// schemas defined in proofMarkSchemas). The inline mark is the single
// source of truth for position; ProseMirror handles position tracking
// across edits, so the decoration always lines up with the underlying
// text without separate sync.
//
// (Earlier versions of this plugin read positions from Y.Map char offsets
// stored at mark-creation time, which drifted out of sync with the doc as
// users typed. That dual-anchor model was the root cause of the
// "yellow underline shifts left as I type" bug.)

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node } from '@milkdown/kit/prose/model'

const key = new PluginKey<DecorationSet>('markDecoration')

// Map an inline mark to its CSS modifier class. authored marks are
// intentionally NOT decorated — every typed character would be tinted,
// which is too much noise.
function classForMark(typeName: string, kind: unknown): string | null {
  if (typeName === 'proofSuggestion') {
    const k = typeof kind === 'string' ? kind : 'replace'
    return `mark-deco mark-deco--${k}`
  }
  if (typeName === 'proofComment') return 'mark-deco mark-deco--comment'
  if (typeName === 'proofFlagged') return 'mark-deco mark-deco--flagged'
  if (typeName === 'proofApproved') return 'mark-deco mark-deco--approved'
  return null
}

function buildDecos(doc: Node): DecorationSet {
  const decos: Decoration[] = []

  // A single proofSuggestion mark can span multiple text nodes (the schema
  // is `spanning: true`). To avoid emitting one ghost per fragment, we
  // first compute the max `to` per markId, then emit exactly one widget
  // anchored at the end of the last fragment.
  const lastTo = new Map<string, number>()
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'proofSuggestion') continue
      const id = mark.attrs.id
      if (typeof id !== 'string') continue
      const to = pos + node.nodeSize
      const cur = lastTo.get(id)
      if (cur === undefined || to > cur) lastTo.set(id, to)
    }
  })

  const ghostEmitted = new Set<string>()
  doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      const className = classForMark(mark.type.name, mark.attrs.kind)
      if (className) {
        decos.push(
          Decoration.inline(pos, pos + node.nodeSize, {
            class: className,
            'data-mark-id': mark.attrs.id ?? '',
          }),
        )
      }

      if (mark.type.name === 'proofSuggestion') {
        const id = mark.attrs.id
        const kind = mark.attrs.kind
        const content = mark.attrs.content
        if (
          typeof id === 'string' &&
          (kind === 'replace' || kind === 'insert') &&
          typeof content === 'string' &&
          content.length > 0 &&
          !ghostEmitted.has(id)
        ) {
          const anchorPos = lastTo.get(id) ?? pos + node.nodeSize
          decos.push(
            Decoration.widget(
              anchorPos,
              () => {
                const span = document.createElement('span')
                span.className = `mark-ghost mark-ghost--${kind}`
                span.dataset.markId = id
                span.contentEditable = 'false'
                span.textContent = content
                return span
              },
              {
                side: 1,
                ignoreSelection: true,
                key: `ghost:${id}`,
              },
            ),
          )
          ghostEmitted.add(id)
        }
      }
    }
  })
  return DecorationSet.create(doc, decos)
}

export function createMarkDecoPlugin() {
  return $prose(
    () =>
      new Plugin({
        key,
        state: {
          init(_, { doc }) {
            return buildDecos(doc)
          },
          apply(tr, decoSet) {
            if (tr.docChanged) return buildDecos(tr.doc)
            return decoSet
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
        },
      }),
  )
}
