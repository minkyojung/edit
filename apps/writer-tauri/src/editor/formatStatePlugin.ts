// Bridge from ProseMirror transactions → React. Watches every view
// update, computes the block type and active inline marks at the
// current selection, and pushes the result into formatStateStore so
// the FormatToolbar can re-render its toggle / label state.
//
// Diffs against the previous store value before writing so we don't
// trigger React re-renders on every keystroke when nothing observable
// has changed (e.g. typing inside the same paragraph with no marks
// toggling).

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

import {
  useFormatStateStore,
  type FormatBlockType,
  type SelectionRect,
} from '@/state/formatStateStore'

function computeBlockType(state: EditorState): FormatBlockType {
  const $from = state.selection.$from
  const parentName = $from.parent.type.name

  if (parentName === 'heading') {
    const level = Number($from.parent.attrs.level)
    if (level >= 1 && level <= 6) {
      return `heading-${level}` as FormatBlockType
    }
    return 'unknown'
  }
  if (parentName === 'code_block') return 'code_block'

  // Walk ancestors so a paragraph nested inside a list/quote reports
  // the wrapping block, not "paragraph". Innermost wrap wins (e.g. a
  // list inside a quote shows "Bullet list").
  // task_list is encoded as a bullet_list whose list_item carries
  // `checked != null` (gfm preset convention) — check the item first
  // so a To-do item reports task_list rather than bullet_list.
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    const name = node.type.name
    if (name === 'list_item' && node.attrs.checked != null) return 'task_list'
    if (name === 'bullet_list') return 'bullet_list'
    if (name === 'ordered_list') return 'ordered_list'
    if (name === 'blockquote') return 'blockquote'
  }

  if (parentName === 'paragraph') return 'paragraph'
  return 'unknown'
}

/** True only if every text node inside [from, to] carries the mark.
 * Matches toggleMark's own "all-covered → remove" decision so the
 * toolbar's active highlight stays consistent with what clicking the
 * button will actually do. */
function rangeFullyMarked(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  type: MarkType,
): boolean {
  let foundText = false
  let allCovered = true
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      foundText = true
      if (!type.isInSet(node.marks)) {
        allCovered = false
        return false
      }
    }
    return undefined
  })
  return foundText && allCovered
}

function computeActiveMarks(state: EditorState): Set<string> {
  const result = new Set<string>()
  const sel = state.selection
  const markTypes = state.schema.marks

  if (sel.empty) {
    // Standard PM pattern for empty selection — storedMarks reflect
    // explicit toggles (e.g. user pressed Bold mid-typing), and
    // $from.marks() reflects the marks the cursor would inherit from
    // the surrounding text.
    const candidates = state.storedMarks ?? sel.$from.marks()
    for (const mark of candidates) {
      result.add(mark.type.name)
    }
    return result
  }

  for (const name of Object.keys(markTypes)) {
    const type = markTypes[name]
    if (rangeFullyMarked(state.doc, sel.from, sel.to, type)) {
      result.add(name)
    }
  }
  return result
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** View-relative bounding box of the range [from, to]. Used by both
 * the plugin (transaction-time) and the SelectionBubble's scroll/resize
 * handler (DOM-time) so the bubble can follow the selection as the
 * viewport moves. */
export function unionCoords(view: EditorView, from: number, to: number): SelectionRect {
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to)
  return {
    top: Math.min(start.top, end.top),
    left: Math.min(start.left, end.left),
    right: Math.max(start.right, end.right),
    bottom: Math.max(start.bottom, end.bottom),
  }
}

function rectEquals(a: SelectionRect | null, b: SelectionRect | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.right === b.right &&
    a.bottom === b.bottom
  )
}

export const formatStatePlugin = $prose(() => {
  return new Plugin({
    view() {
      return {
        update(view, prevState) {
          if (
            view.state.selection.eq(prevState.selection) &&
            view.state.doc.eq(prevState.doc)
          ) {
            return
          }
          const newBlock = computeBlockType(view.state)
          const newMarks = computeActiveMarks(view.state)
          const sel = view.state.selection
          // IME composition (Korean / Japanese / Chinese) constantly
          // moves the selection mid-keystroke; treating composition
          // as "no bubble" keeps the SelectionBubble from flickering.
          // A NodeSelection (a whole block selected — image/video card or a
          // mermaid/artifact viz block) is also "no bubble": inline mark
          // formatting doesn't apply to a node, so the toolbar must not pop.
          const empty = sel.empty || view.composing || sel instanceof NodeSelection
          const rect = empty ? null : unionCoords(view, sel.from, sel.to)
          const prev = useFormatStateStore.getState()
          if (
            prev.blockType === newBlock &&
            setEquals(prev.activeMarks, newMarks) &&
            prev.selectionEmpty === empty &&
            rectEquals(prev.selectionRect, rect)
          ) {
            return
          }
          useFormatStateStore.setState({
            blockType: newBlock,
            activeMarks: newMarks,
            selectionEmpty: empty,
            selectionRect: rect,
          })
        },
      }
    },
  })
})
