// Address a visualization block by its stable id (see vizIdPlugin / fenceMeta).
// Because the lookup is by id, not position, it stays correct as the document
// changes — the basis for "AI/chat, edit THAT chart" from any session.
//
// MVP scope: operates on the currently-open editor (the active EditorView). A
// block in a doc that isn't open would need a markdown-level apply; that's a
// later extension.

import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/** Find the viz code block carrying `id`, with its position. */
export function findVizById(
  state: EditorState,
  id: string,
): { pos: number; node: PMNode } | null {
  if (!id) return null
  let found: { pos: number; node: PMNode } | null = null
  state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'code_block' && node.attrs.vizId === id) {
      found = { pos, node }
      return false
    }
    return undefined
  })
  return found
}

/** Current source (text content, e.g. the chart JSON) of the block, for feeding
 * the AI as the thing-to-modify. Null if no such id. */
export function getVizSourceById(state: EditorState, id: string): string | null {
  return findVizById(state, id)?.node.textContent ?? null
}

/** Replace that block's source in place via a PM transaction — keeps the node
 * (and its id/language), swapping only the content. Returns false if the id
 * isn't in the active doc. */
export function replaceVizById(view: EditorView, id: string, newSource: string): boolean {
  const hit = findVizById(view.state, id)
  if (!hit) return false
  const { pos, node } = hit
  const start = pos + 1
  const end = pos + node.nodeSize - 1
  const { schema } = view.state
  let tr = view.state.tr
  tr =
    newSource.length > 0
      ? tr.replaceWith(start, end, schema.text(newSource))
      : tr.delete(start, end)
  view.dispatch(tr.scrollIntoView())
  return true
}
