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

import { diffLines, structuredPatch } from 'diff'
import type { DiffLine } from './git'
import { locateLoose } from './looseMatch'
import type { Placement } from '@/lib/editPlacement'
import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'

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

/** Apply a change's edits to the page snapshot, returning the resulting body. Pure
 * string transform mirroring the applier's write paths — `add` appends to the end
 * (appendMarkdownToWikiPage); `replace`/`delete` locate `before` via the SAME tolerant,
 * ambiguity-safe matcher the real disk-apply path uses (`looseReplace` — exact match,
 * falling back to a normalized single-line match, refusing when more than one candidate
 * matches). Before this, this function did its own plain `String.replace`, which could
 * disagree with the real apply path about whether/where an edit lands — the preview
 * would show one result while the actual save silently did something else. A whole-file
 * replace (no `before`) swaps the body. Used to derive the "after" page so the diff can
 * show document context, not just the changed fragment.
 *
 * NOTE: this is a SEPARATE implementation from `editor/cmHunks.applyEditsToText`
 * (which drives the in-buffer green). They agree on replace/delete/whole-file but
 * their `add` branches differ (this one inserts a `\n\n` separator; cmHunks does
 * not) — harmless only because production `add` edits target empty new notes. See
 * the divergence note on `cmHunks.resolveAddInsertion` before unifying. */
export function applyEditsToText(snapshot: string, edits: PendingEdit[]): string {
  return placeEditsInSnapshot(snapshot, edits).text
}

/** `applyEditsToText` plus WHY it came out that way.
 *
 * Mirrors `cmHunks.placeEdits` — one walk producing both the text and the
 * verdict, so the answer given to the model and the text the user is shown can
 * never come from two different notions of "did this edit land". The two walks
 * stay separate (their `add` branches genuinely differ, see the note above);
 * only the verdict vocabulary is shared. */
export function placeEditsInSnapshot(
  snapshot: string,
  edits: PendingEdit[],
): { text: string; placement: Placement } {
  let doc = snapshot
  let failure: Placement | null = null
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (e.kind === 'add') {
      const body = e.after ?? ''
      doc = doc.length > 0 ? `${doc}\n\n${body}` : body
    } else if (e.kind === 'replace' && !e.before) {
      doc = e.after ?? '' // whole-file replace — nothing to locate
    } else if ((e.kind === 'replace' || e.kind === 'delete') && e.before) {
      const replacement = e.kind === 'delete' ? '' : (e.after ?? '')
      const m = locateLoose(doc, e.before)
      if (m.kind === 'found') {
        doc = doc.slice(0, m.start) + replacement + doc.slice(m.end)
      } else if (m.kind === 'ambiguous') {
        failure ??= { kind: 'ambiguous', editIndex: i, target: e.before }
      } else if (replacement && doc.includes(replacement)) {
        // Already made — most often by the PREVIOUS tool call this same turn,
        // which is exactly the situation this merge path exists to handle.
      } else {
        failure ??= { kind: 'absent', editIndex: i, target: e.before }
      }
    }
  }
  const placement: Placement = failure ?? (doc === snapshot ? { kind: 'noop' } : { kind: 'ok' })
  return { text: doc, placement }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  let i = 0
  for (;;) {
    const idx = haystack.indexOf(needle, i)
    if (idx === -1) return n
    n += 1
    i = idx + needle.length
  }
}

/** Context-free fragment diff (the pre-context behaviour): diff each edit's own
 * before→after. Used as a fallback when document context can't be derived. */
function fragmentDiff(change: PendingChange): DiffLine[] {
  const snapshot = change.pageMarkdownSnapshot ?? ''
  return diffPairsToLines(
    change.edits.map((edit) => ({
      // Whole-file replace (no `before`) diffs against the page snapshot.
      before: edit.kind === 'replace' && !edit.before ? snapshot : (edit.before ?? ''),
      after: edit.after ?? '',
    })),
  )
}

/** Diff lines for a pending change, WITH 3 lines of document context around each change
 * (GitHub-style). We diff the page snapshot against the page with the edits applied, so
 * the surrounding note text shows — not just the edited fragment.
 *
 * Falls back to the context-free fragment diff when there's no snapshot (legacy
 * persisted entries) OR when applying the edits to the snapshot changes nothing — e.g.
 * a `before` that loose-matched on disk but isn't a literal substring of the snapshot.
 * Without that fallback the change would silently vanish from the card. */
export function computePendingDiffLines(change: PendingChange): DiffLine[] {
  const snapshot = change.pageMarkdownSnapshot
  if (snapshot == null) return fragmentDiff(change)
  // Only render the document-context diff when EVERY before-anchored edit matches the
  // snapshot literally and unambiguously (exactly one occurrence). Otherwise
  // applyEditsToText's first-occurrence String.replace could mis-place or silently drop
  // an edit (multi-occurrence, or a `before` that only loose-matched on disk). Fall back
  // to the per-edit fragment diff, which faithfully shows EVERY edit (no context).
  const cleanlyApplies = change.edits.every((e) => {
    if (e.kind === 'add') return true
    if (e.kind === 'replace' && !e.before) return true // whole-file swap
    return !!e.before && countOccurrences(snapshot, e.before) === 1
  })
  if (!cleanlyApplies) return fragmentDiff(change)
  const after = applyEditsToText(snapshot, change.edits)
  if (after === snapshot) return fragmentDiff(change)
  const patch = structuredPatch(
    'a',
    'b',
    withTrailingNewline(snapshot),
    withTrailingNewline(after),
    '',
    '',
    { context: 3 },
  )
  const out: DiffLine[] = []
  patch.hunks.forEach((hunk, hi) => {
    // A gap between hunks (omitted unchanged lines) — a faint ellipsis row.
    if (hi > 0) out.push({ kind: 'context', text: '⋯', lineNum: 0 })
    for (const raw of hunk.lines) {
      const tag = raw[0]
      if (tag === '\\') continue // "\ No newline at end of file"
      const text = raw.slice(1)
      const kind: DiffLine['kind'] = tag === '+' ? 'add' : tag === '-' ? 'remove' : 'context'
      out.push({ kind, text, lineNum: 0 })
    }
  })
  return out
}
