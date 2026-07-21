// Compare-and-swap primitives for the whole-doc write guard (Layer B of the
// stale-overwrite fix). A whole-doc overwrite (`applyWriteWikiPage`) replaces
// the entire body, so `updateDocBody`'s live-editor read can't protect it —
// the transform discards `current`. Instead the caller passes the body its
// write was computed against (`expectedBase`); the funnel compares that to the
// LIVE body at write time and refuses ("stale") when they diverged, so a user
// editing the note while an async AI generation was in flight is never
// clobbered. Mirrors Claude Code's built-in "file changed since read → error"
// semantics.

import { structuredPatch } from 'diff'

export interface LineRange {
  /** 1-based first changed line in `latest`. */
  from: number
  /** 1-based last changed line in `latest` (== from for a pure insertion
   * point). */
  to: number
}

/** True when two bodies are equal for CAS purposes. Normalises a missing
 * trailing newline (the common spurious diff) so an otherwise-identical body
 * doesn't read as diverged. */
function withTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : `${s}\n`
}

export function bodiesEqual(a: string, b: string): boolean {
  return withTrailingNewline(a) === withTrailingNewline(b)
}

/** Line ranges (1-based, positioned in `latest`) that differ from `base`.
 * Empty when the bodies are equal. Handed to the model on a stale refusal so
 * it can rebase against the latest body without a full re-read. */
export function changedLineRanges(base: string, latest: string): LineRange[] {
  // Normalise trailing newline first: without it `diff` tokenises the final
  // line as changed whenever only one side ends in `\n`, surfacing an appended
  // line as a spurious two-line (modify last + add) hunk.
  const patch = structuredPatch(
    'base',
    'latest',
    withTrailingNewline(base),
    withTrailingNewline(latest),
    '',
    '',
    { context: 0 },
  )
  return patch.hunks.map((h) => ({
    from: h.newStart,
    // A pure deletion has newLines === 0; report the insertion point as a
    // single-line range rather than an inverted (to < from) one.
    to: h.newStart + Math.max(h.newLines, 1) - 1,
  }))
}
