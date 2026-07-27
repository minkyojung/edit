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
import { looseFindRange, locateLoose } from '@/lib/looseMatch'
import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'
import type { Placement } from '@/lib/editPlacement'

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
 * after the LAST occurrence of the anchor text.
 *
 * ⚠️ There are THREE `add`/append implementations that DIVERGE, and none is wrong
 * in practice only because of a narrow reachability invariant — do NOT "fix" one
 * to match another without re-checking it:
 *   • this file (in-buffer green, mounted): inserts `after` verbatim at the anchor
 *     position, NO separator → `…lastLine.appended` gets GLUED onto the last line.
 *   • `lib/pendingDiff.applyEditsToText` (chat card diff): `doc + '\n\n' + after`.
 *   • `applyIngest.appendMarkdownToWikiPage` (disk, unmounted): trimEnd + '\n\n' +
 *     trimmed + '\n'.
 * The gluing / non-empty-anchor cases are UNREACHABLE today: the only production
 * `add` PendingChange is a NEW-note body (see toPendingChange — createdNewNote),
 * so the target doc is EMPTY (anchor → 0, no last line to glue). Appends to an
 * EXISTING page never become a reviewable PendingChange — they call
 * appendMarkdownToWikiPage directly. If that invariant ever changes (an `add`
 * targeting a non-empty open doc), unify all three on the applier's semantics. */
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

/** Apply a change's edits to `docText`, returning both the resulting text and
 * WHY it turned out that way.
 *
 * One walk produces both on purpose. The check that decides whether to accept a
 * proposal and the application that decides what gets drawn have to agree — two
 * implementations of "can this edit be placed" is precisely how a proposal comes
 * to pass its own check and then render nothing.
 *
 * Placement follows the applier's primitives (looseReplace / resolveAddInsertion)
 * so "a mark shows" ⟺ "Keep will place it". An unplaceable edit is SKIPPED, not
 * abandoned — the remaining edits still apply, matching the previous behaviour —
 * and the first failure is what gets reported. */
export function placeEdits(
  docText: string,
  change: { edits: PendingEdit[] },
): { text: string; placement: Placement } {
  let text = docText
  let failure: Placement | null = null
  for (let i = 0; i < change.edits.length; i++) {
    const e = change.edits[i]
    if ((e.kind === 'replace' || e.kind === 'delete') && e.before) {
      const replacement = e.kind === 'delete' ? '' : (e.after ?? '')
      const m = locateLoose(text, e.before)
      if (m.kind === 'found') {
        text = text.slice(0, m.start) + replacement + text.slice(m.end)
      } else if (m.kind === 'ambiguous') {
        failure ??= { kind: 'ambiguous', editIndex: i, target: e.before }
      } else if (replacement && text.includes(replacement)) {
        // The anchor is gone but what it was to BECOME is present: this edit has
        // already been made (the user accepted it, or made it themselves). Not a
        // failure — skipping it leaves the text as the model wanted it.
      } else {
        failure ??= { kind: 'absent', editIndex: i, target: e.before }
      }
    } else if (e.kind === 'add') {
      const at = resolveAddInsertion(text, e.anchorBefore)
      if (at !== null) text = text.slice(0, at) + (e.after ?? '') + text.slice(at)
      else failure ??= { kind: 'absent', editIndex: i, target: e.anchorBefore }
    } else if (e.kind === 'replace' && !e.before) {
      // Whole-file Write: the new text IS the whole document, nothing to locate.
      text = e.after ?? ''
    }
  }
  // A failure outranks `noop`: when one edit couldn't be placed and the rest
  // changed nothing, the honest answer is why it couldn't be placed.
  const placement: Placement = failure ?? (text === docText ? { kind: 'noop' } : { kind: 'ok' })
  return { text, placement }
}

/** The "after" side of the diff — `placeEdits` without the verdict. */
export function applyEditsToText(docText: string, change: PendingChange): string {
  return placeEdits(docText, change).text
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
