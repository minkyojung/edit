// Drop-in replacement for milkdown's toggleInlineCodeCommand that
// preserves proofMark anchors.
//
// The preset version strips ALL other marks in the range when adding
// inlineCode (correct for markdown round-trip — `**bold**` inside a
// code span is just literal asterisks). But it would also strip our
// proofMark family, silently orphaning AI suggestions/comments —
// the Y.Map metadata stays around but the PM mark vanishes, so the
// hover/click affordance dies.
//
// We do the same standard-mark cleanup but keep proofMark marks.

import { $prose } from '@milkdown/kit/utils'
import { keymap } from '@milkdown/kit/prose/keymap'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Command } from '@milkdown/kit/prose/state'

const PROOF_MARK_NAMES = new Set([
  'proofSuggestion',
  'proofComment',
  'proofFlagged',
  'proofApproved',
  'proofAuthored',
  'proofProvenance',
])

const INLINE_CODE_MARK_NAME = 'inlineCode'

const toggleInlineCodeCommand: Command = (state, dispatch) => {
  const { selection, schema, tr, doc } = state
  if (selection.empty) return false

  const codeType = schema.marks[INLINE_CODE_MARK_NAME]
  if (!codeType) return false

  const { from, to } = selection

  if (doc.rangeHasMark(from, to, codeType)) {
    dispatch?.(tr.removeMark(from, to, codeType))
    return true
  }

  for (const name of Object.keys(schema.marks)) {
    if (name === INLINE_CODE_MARK_NAME) continue
    if (PROOF_MARK_NAMES.has(name)) continue
    tr.removeMark(from, to, schema.marks[name])
  }
  dispatch?.(tr.addMark(from, to, codeType.create()))
  return true
}

export function toggleInlineCodeSafe(view: EditorView): boolean {
  const ok = toggleInlineCodeCommand(view.state, view.dispatch)
  if (ok) view.focus()
  return ok
}

// Registered before the commonmark preset's Mod-e binding so we win
// the keymap race and the unsafe toggle never runs.
export const inlineCodeSafeKeymap = $prose(() =>
  keymap({ 'Mod-e': toggleInlineCodeCommand }),
)
