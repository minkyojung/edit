// ProseMirror transaction logger. Plugged into the editor so every
// state change funnels through `dbg('tr', ...)` and lands in the
// editorDebug ring buffer. The plugin holds no state of its own — it
// just observes via `state.apply` and reports.
//
// Why a plugin instead of a `view.dispatch` wrap: dispatch wrappers
// miss transactions that originate inside the collab plugin or other
// plugin filters. The plugin's state.apply fires for every applied
// transaction regardless of source, which is exactly what we want.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { dbg } from '@/lib/editorDebug'

const debugKey = new PluginKey('writer-debug')

function describeNode(node: PMNode | null | undefined): string {
  if (!node) return '<none>'
  const name = node.type.name
  if (name === 'heading') return `heading:l${node.attrs.level}`
  return name
}

function originLabel(tr: Transaction): string {
  // Collect every key set via setMeta — y-prosemirror, the collab
  // plugin, and our own dispatches all stash hints there. We don't
  // know the exact keys ahead of time, so reflect over the meta map.
  const metaKeys: string[] = []
  // `meta` is internal to PM but stable in practice — accessing via
  // `as unknown as { meta: ... }` keeps TS quiet without leaking it
  // to callers.
  const meta = (tr as unknown as { meta?: Record<string, unknown> }).meta
  if (meta) {
    for (const k of Object.keys(meta)) {
      // PluginKey-keyed metas show up as the PluginKey object's
      // toString; that's fine — we just want a fingerprint.
      metaKeys.push(k)
    }
  }
  if (metaKeys.length === 0) return '<no-meta>'
  return metaKeys.join(',')
}

export const editorDebugPlugin = $prose(
  () =>
    new Plugin({
      key: debugKey,
      state: {
        init() {
          return null
        },
        apply(tr: Transaction, _value, oldState: EditorState, newState: EditorState) {
          // Skip pure selection-only transactions to avoid drowning
          // the buffer in cursor moves. We still log them when the
          // selection crosses node boundaries (parent node changes).
          const isContentChange = tr.docChanged
          const oldHeadParent = oldState.selection.$head.parent
          const newHeadParent = newState.selection.$head.parent
          const parentChanged = oldHeadParent.type.name !== newHeadParent.type.name
          if (!isContentChange && !parentChanged) return null

          const oldFirst = oldState.doc.firstChild
          const newFirst = newState.doc.firstChild
          const firstChanged =
            describeNode(oldFirst) !== describeNode(newFirst)

          dbg('tr', isContentChange ? 'apply' : 'select', {
            origin: originLabel(tr),
            steps: tr.steps.length,
            sizeBefore: oldState.doc.content.size,
            sizeAfter: newState.doc.content.size,
            firstNode: describeNode(newFirst),
            firstChanged,
            childCount: newState.doc.childCount,
            selectionInParent: newHeadParent.type.name,
          })
          return null
        },
      },
    }),
)
