// Single anchor resolver: find where an edit's text anchor sits in the
// live PM doc, returning a PM-position range.
//
// This is the editor's half of the "where does this edit go" question
// (the disk/apply half is lib/looseMatch against bodyMarkdown). Both
// must agree, so they share ONE normalization idea — strip the inline
// markdown decorations that differ between the on-disk markdown form
// (what the LLM's anchor carries) and the editor's rendered text:
//   - wikilinks: `[[Title]]` / `[Title](note:slug)` → `Title`
//   - leading block markers: `- `, `1. `, `#`, `> `
//
// Two failures of the old per-text-node search this fixes:
//   1. A line with inline formatting (a wikilink, bold, …) is split
//      into several text nodes, so a per-node `indexOf` could never
//      match text spanning the split. We search each TEXTBLOCK's whole
//      `textContent` instead. Inline marks don't consume PM positions,
//      so a textContent offset maps 1:1 onto a doc position.
//   2. A `[[Title]]` anchor never matched the rendered `Title`. We try
//      the wikilink-stripped form too.

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { stripWikilinks } from '@/lib/wikilinkSyntax'
import { canonicalizeLine, leadingMarkerLength } from '@/lib/lineCanonical'

/** Strip the leading line's markdown block marker so an anchor like
 * "- 31살" becomes "31살" — the form the rendered text carries (the
 * bullet / heading marker is drawn by the NodeView, not in text). */
export function stripFirstLineMarkdownMarker(s: string): string {
  const nl = s.indexOf('\n')
  const firstLine = nl >= 0 ? s.slice(0, nl) : s
  const rest = nl >= 0 ? s.slice(nl) : ''
  const stripped = firstLine.replace(/^(?:#+\s+|[-*+]\s+|\d+\.\s+|>\s+)/, '')
  return stripped + rest
}

/** Search every textblock's concatenated `textContent` for `target`,
 * returning the (first, or last when `last`) occurrence as a PM range.
 * Searching the whole block — not individual text nodes — is what lets
 * a match span inline marks (links / bold). */
function searchTextblocks(
  doc: PMNode,
  target: string,
  last: boolean,
): { from: number; to: number } | null {
  if (target.length === 0) return null
  let result: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (!last && result) return false
    if (!node.isTextblock) return true // recurse into containers
    const text = node.textContent
    const idx = last ? text.lastIndexOf(target) : text.indexOf(target)
    if (idx >= 0) {
      // +1 to step inside the textblock's opening token; inline marks
      // add no positions, so textContent offset == position offset.
      const from = pos + 1 + idx
      result = { from, to: from + target.length }
    }
    return false // never descend into a textblock's inline children
  })
  return result
}

/** Tier 2 — tolerant whole-line match. Compare the CANONICAL form of
 * `target` against each textblock's canonical text (`canonicalizeLine`,
 * shared with lib/looseMatch so editor and disk agree), recovering the
 * range from line boundaries — NOT from a canonical offset, since
 * canonicalization is length-changing. Single-line only (it compares
 * whole lines); multi-line targets fall through to null. */
function searchCanonicalLine(
  doc: PMNode,
  target: string,
  last: boolean,
): { from: number; to: number } | null {
  if (target.includes('\n')) return null
  const canon = canonicalizeLine(target)
  if (canon.length === 0) return null
  let result: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (!last && result) return false
    if (!node.isTextblock) return true
    const text = node.textContent
    if (canonicalizeLine(text) === canon) {
      // Rendered text carries no markdown marker (the NodeView draws
      // it), so this is normally the whole line content.
      const from = pos + 1 + leadingMarkerLength(text)
      result = { from, to: pos + 1 + text.length }
    }
    return false
  })
  return result
}

/** Find `target` in the doc, tolerating the markdown-vs-rendered form
 * gap. Tier 1: verbatim search of the literal anchor and its
 * wikilink/marker-stripped forms (sub-line precise; textContent offset
 * maps 1:1 to a PM position). Tier 2: canonical whole-line match
 * (`searchCanonicalLine`) — the SAME `canonicalizeLine` lib/looseMatch
 * uses, so editor placement and disk apply resolve the same anchors
 * (indent / colon-spacing / whitespace drift). Returns the matched
 * PM-position range, or null. */
export function findTextRange(
  doc: PMNode,
  target: string,
  opts: { last?: boolean } = {},
): { from: number; to: number } | null {
  const last = opts.last ?? false
  const seen = new Set<string>()
  const candidates = [
    target,
    stripWikilinks(target),
    stripFirstLineMarkdownMarker(target),
    stripFirstLineMarkdownMarker(stripWikilinks(target)),
  ]
  for (const candidate of candidates) {
    if (candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    const range = searchTextblocks(doc, candidate, last)
    if (range) return range
  }
  // Tier 2 — tolerant canonical whole-line fallback.
  return searchCanonicalLine(doc, target, last)
}
