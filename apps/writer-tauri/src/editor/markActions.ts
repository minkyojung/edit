/**
 * Client-side mark actions: accept / reject / dismiss.
 *
 * These bypass the proof-server's HTTP ops API and operate directly on the
 * ProseMirror EditorView + Yjs Y.Map. Yjs auto-syncs both the doc text
 * (via y-prosemirror) and the Y.Map metadata to the server, mirroring how
 * proof-sdk's web client behaves.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'
import type { StoredMark } from '../hooks/useCollabDoc'

interface FoundAnchor {
  from: number
  to: number
  mark: Mark
}

function findInlineAnchor(view: EditorView, markId: string, schemaName: string): FoundAnchor | null {
  let result: FoundAnchor | null = null
  view.state.doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if (m.type.name === schemaName && m.attrs.id === markId) {
        result = { from: pos, to: pos + node.nodeSize, mark: m }
        return false
      }
    }
  })
  return result
}

export function acceptMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] accept: anchor not found', markId)
    return false
  }
  const { from, to, mark } = anchor
  const kind = mark.attrs.kind as 'replace' | 'insert' | 'delete'
  const content = mark.attrs.content as string | null

  const tr = view.state.tr
  if (kind === 'delete') {
    tr.delete(from, to)
  } else if (kind === 'replace') {
    if (content === null || content === undefined) return false
    tr.replaceWith(from, to, view.state.schema.text(content))
  } else if (kind === 'insert') {
    if (content === null || content === undefined) return false
    // Insert text at the anchor position; mark wraps a placeholder we now replace.
    tr.replaceWith(from, to, view.state.schema.text(content))
  } else {
    return false
  }
  view.dispatch(tr)

  ydoc.getMap<StoredMark>('marks').delete(markId)
  return true
}

export function rejectMark(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofSuggestion')
  if (!anchor) {
    console.error('[markActions] reject: anchor not found', markId)
    return false
  }
  const { from, to } = anchor
  const markType = view.state.schema.marks.proofSuggestion
  view.dispatch(view.state.tr.removeMark(from, to, markType))
  ydoc.getMap<StoredMark>('marks').delete(markId)
  return true
}

export function resolveComment(view: EditorView, ydoc: Y.Doc, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId, 'proofComment')
  if (anchor) {
    const markType = view.state.schema.marks.proofComment
    view.dispatch(view.state.tr.removeMark(anchor.from, anchor.to, markType))
  }
  ydoc.getMap<StoredMark>('marks').delete(markId)
  return true
}
