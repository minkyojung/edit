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
import { TextSelection } from '@milkdown/kit/prose/state'
import * as Y from 'yjs'
import type { StoredMark } from '../hooks/useCollabDoc'
import { useEditorViewStore } from '@/state/editorViewStore'

interface FoundAnchor {
  from: number
  to: number
  mark: Mark
}

const ANCHOR_SCHEMAS = ['proofSuggestion', 'proofComment'] as const

function findInlineAnchor(
  view: EditorView,
  markId: string,
  schemaName?: string,
): FoundAnchor | null {
  const targets = schemaName ? [schemaName] : ANCHOR_SCHEMAS
  let result: FoundAnchor | null = null
  view.state.doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if ((targets as readonly string[]).includes(m.type.name) && m.attrs.id === markId) {
        result = { from: pos, to: pos + node.nodeSize, mark: m }
        return false
      }
    }
  })
  return result
}

/**
 * Move selection + scroll to the inline anchor of the given mark, and
 * briefly flash it. Returns true if the mark was found.
 */
export function jumpToMark(view: EditorView, markId: string): boolean {
  const anchor = findInlineAnchor(view, markId)
  if (!anchor) return false

  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, anchor.from, anchor.to),
  )
  view.dispatch(tr.scrollIntoView())
  view.focus()

  flashRange(view, anchor.from, anchor.to)
  return true
}

function flashRange(view: EditorView, from: number, to: number) {
  // Walk the rendered DOM for the range and toggle a CSS class for ~1s.
  const startDom = view.domAtPos(from)
  const endDom = view.domAtPos(to)
  const start = startDom.node instanceof Element ? startDom.node : startDom.node.parentElement
  const end = endDom.node instanceof Element ? endDom.node : endDom.node.parentElement
  if (!start || !end) return

  const touched: Element[] = []
  let node: Element | null = start
  while (node) {
    touched.push(node)
    if (node === end) break
    const sibling: Element | null = node.nextElementSibling
    node = sibling ?? node.parentElement?.nextElementSibling ?? null
    if (touched.length > 50) break
  }
  for (const el of touched) el.classList.add('mark-flash')
  window.setTimeout(() => {
    for (const el of touched) el.classList.remove('mark-flash')
  }, 1000)
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
    // Ingest proposals: `content` is a markdown string from the LLM
    // (e.g. "### Sarah\n- Workplace colleague"). Parse it through
    // Milkdown's own commonmark+gfm pipeline so it becomes real
    // heading / list nodes, then insert those blocks after the block
    // that holds the anchor word. The anchor itself stays put — we
    // just strip its proofSuggestion mark — so the visible result is
    // the original line followed by the new structured content.
    const parser = useEditorViewStore.getState().parser
    if (!parser) {
      console.error('[markActions] accept(insert): parser not ready')
      return false
    }
    const parsed = parser(content)
    if (!parsed || parsed.content.size === 0) {
      console.error('[markActions] accept(insert): parser produced empty doc', content)
      return false
    }
    const markType = view.state.schema.marks.proofSuggestion
    if (markType) tr.removeMark(from, to, markType)
    const blockEnd = view.state.doc.resolve(to).after()
    tr.insert(blockEnd, parsed.content)
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
