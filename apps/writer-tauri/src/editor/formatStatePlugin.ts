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
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model'

import { useFormatStateStore, type FormatBlockType } from '@/state/formatStateStore'

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
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
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
          const prev = useFormatStateStore.getState()
          if (
            prev.blockType === newBlock &&
            setEquals(prev.activeMarks, newMarks)
          ) {
            return
          }
          useFormatStateStore.setState({
            blockType: newBlock,
            activeMarks: newMarks,
          })
        },
      }
    },
  })
})
