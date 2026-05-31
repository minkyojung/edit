// Git-style +/- diff lines for a pending change — the Review panel's
// single, robust way to show what an unaccepted change does.
//
// The panel used to render a live Milkdown preview with widget / mark
// overlays; that path kept breaking at the seams (snapshot vs live
// resolution, parser timing, read-only dispatch). This computes the
// diff as plain `DiffLine[]` instead — the exact shape the committed-
// change cards already render — so the panel reuses one rendering and
// has no editor / reconcile / parser to go wrong.
//
// Granularity is line-level (whole-line +/-), matching git + the
// committed-change view: an inline tweak shows as `-old line / +new
// line`, an appended bullet as a single `+` line.

import { diffLines } from 'diff'
import type { DiffLine } from './git'
import type { PendingChange } from '@/state/pendingChangesStore'

/** diffLines tokenises by line; a string whose last line lacks a
 * trailing newline makes that line's token differ from an otherwise
 * identical line that has one — surfacing unchanged lines as a spurious
 * remove+add. Normalising both sides to end in `\n` avoids it. */
function withTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : `${s}\n`
}

/** Split a diff chunk's value into lines, dropping the empty tail the
 * trailing newline produces. */
function toLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Flatten `{ before, after }` pairs into `+`/`-` diff lines. The shared
 * primitive behind both the store-backed pending diff and the chat
 * message's input-derived diff, so every surface renders edits the same
 * way. */
export function diffPairsToLines(
  pairs: Array<{ before: string; after: string }>,
): DiffLine[] {
  const out: DiffLine[] = []
  for (const { before, after } of pairs) {
    const parts = diffLines(withTrailingNewline(before), withTrailingNewline(after))
    for (const part of parts) {
      if (!part.added && !part.removed) continue // unchanged context — skip
      const kind: 'add' | 'remove' = part.added ? 'add' : 'remove'
      for (const text of toLines(part.value)) {
        out.push({ kind, text, lineNum: 0 })
      }
    }
  }
  return out
}

/** Flatten a pending change's edits into `+`/`-` diff lines.
 *
 * Per edit the "before" text is:
 *   - whole-file replace (replace with no `before`) → the page snapshot
 *   - otherwise → the edit's own `before` (empty for a pure add)
 * and the "after" is the edit's `after` (empty for a pure delete). */
export function computePendingDiffLines(change: PendingChange): DiffLine[] {
  return diffPairsToLines(
    change.edits.map((edit) => ({
      before:
        edit.kind === 'replace' && !edit.before
          ? (change.pageMarkdownSnapshot ?? '')
          : (edit.before ?? ''),
      after: edit.after ?? '',
    })),
  )
}
