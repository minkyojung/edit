// Whole-document diff → hunk computation for the CodeMirror AI-suggestion
// preview (cmProofReview). Pure text logic, no CodeMirror / DOM imports, so it
// is unit-testable in isolation.
//
// The canonical model: instead of re-locating each individual edit in the live
// doc (which drops whole-file Write and silently loses anchor misses), we apply
// the change's edits to a copy of the doc, then line-diff the result against the
// live doc. Every edit shape — inline replace, delete, add/append, and
// whole-file Write — collapses to the same red(removed)/green(added) hunks.

import { diffLines } from 'diff'
import { looseReplace, looseFindRange } from '@/lib/looseMatch'
import type { PendingChange } from '@/state/pendingChangesStore'

export type CmHunk = {
  /** Char offset into the live doc where the hunk starts. */
  from: number
  /** End of the removed range; for 'add' === from (a pure insertion point). */
  to: number
  /** Inserted / replacement text ('' for a delete). */
  after: string
  kind: 'replace' | 'delete' | 'add'
}

/** Where an `add` lands: end of doc for the empty anchor (append), else just
 * after the LAST occurrence of the anchor text. Mirrors the applier's insertion
 * rule so "a widget shows" ⟺ "Keep inserts there". */
export function resolveAddInsertion(doc: string, anchor: string): number | null {
  if (anchor.length === 0) return doc.length
  const i = doc.lastIndexOf(anchor)
  return i < 0 ? null : i + anchor.length
}

/** Best doc offset to scroll to for a change — used when the user clicks a chat
 * suggestion card to jump to the spot in the note. Prefers the `before` anchor
 * (the text actually in the doc while pending), then `after`, then an `add`'s
 * insertion point. Null when nothing resolves (e.g. a rejected change). */
export function scrollOffsetForChange(docText: string, change: PendingChange): number | null {
  for (const e of change.edits) {
    if (e.before) {
      const r = looseFindRange(docText, e.before)
      if (r) return r.start
    }
    if (e.after) {
      const r = looseFindRange(docText, e.after)
      if (r) return r.start
    }
    if (e.kind === 'add') {
      const at = resolveAddInsertion(docText, e.anchorBefore)
      if (at !== null) return at
    }
  }
  return null
}

/** Apply a change's edits to `docText` and return the resulting document text —
 * the "after" side of the diff. Each edit is applied in order against the
 * running text using the SAME primitives the applier uses (looseReplace /
 * resolveAddInsertion) so "a mark shows" ⟺ "Keep will place it". An edit that
 * can't be located is skipped (it simply won't appear in the diff). */
export function applyEditsToText(docText: string, change: PendingChange): string {
  let text = docText
  for (const e of change.edits) {
    if ((e.kind === 'replace' || e.kind === 'delete') && e.before) {
      const replaced = looseReplace(text, e.before, e.kind === 'delete' ? '' : (e.after ?? ''))
      if (replaced !== null) text = replaced
    } else if (e.kind === 'add') {
      const at = resolveAddInsertion(text, e.anchorBefore)
      if (at !== null) text = text.slice(0, at) + (e.after ?? '') + text.slice(at)
    } else if (e.kind === 'replace' && !e.before) {
      // Whole-file Write: the new text IS the whole document.
      text = e.after ?? ''
    }
  }
  return text
}

/** Apply hunks back onto `docText` — the inverse direction of computeCmHunks,
 * used at Keep time to land the (possibly user-edited) green text. Each hunk's
 * [from, to) is replaced by its `after`. Applied right-to-left so earlier offsets
 * stay valid. Because the old (red) spans are frozen while pending, the user's
 * own edits only ever live OUTSIDE these ranges — so applying the hunks to the
 * CURRENT doc preserves those edits AND lands the proposal (the Cursor-style
 * merge, with no diff3). */
export function applyHunks(
  docText: string,
  hunks: readonly { from: number; to: number; after: string }[],
): string {
  let text = docText
  for (const h of [...hunks].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, h.from) + h.after + text.slice(h.to)
  }
  return text
}

/** Diff `docText` against the change's applied result and fold the line-level
 * diff into hunks (char offsets into `docText`):
 *   - a removed run followed by an added run → one 'replace' hunk
 *   - a removed run alone → a 'delete' hunk
 *   - an added run alone → an 'add' hunk (pure insertion, from === to)
 * Returns [] when the change is a no-op (or none of its edits could be placed). */
export function computeCmHunks(docText: string, change: PendingChange): CmHunk[] {
  const resultText = applyEditsToText(docText, change)
  if (resultText === docText) return []
  const parts = diffLines(docText, resultText)
  const out: CmHunk[] = []
  let pos = 0 // running char offset into docText
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      pos += part.value.length
      continue
    }
    let removedLen = 0
    let addedText = ''
    if (part.removed) {
      removedLen = part.value.length
      const nextAdded = parts[i + 1]
      if (nextAdded?.added) {
        addedText = nextAdded.value
        i++ // consume the paired added run
      }
    } else {
      addedText = part.value
    }
    const from = pos
    const to = pos + removedLen
    const kind: CmHunk['kind'] = removedLen > 0 ? (addedText ? 'replace' : 'delete') : 'add'
    out.push({ from, to, after: addedText, kind })
    pos += removedLen // added text doesn't consume docText offset
  }
  return out
}
