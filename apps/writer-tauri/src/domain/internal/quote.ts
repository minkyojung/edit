/**
 * Locate a quote string in a ProseMirror document.
 *
 * The markStore needs to turn `quote: string` into a concrete PM
 * position range at create time. The naive approach — `textBetween`
 * the whole doc then `indexOf` — works for the string match itself
 * but then has to map a flat-string index back to a PM position,
 * which is fragile across block boundaries.
 *
 * This implementation walks PM text nodes directly. The first text
 * node whose text contains the quote yields the match. That
 * intentionally skips cross-paragraph spans — for our domain (single
 * AI suggestion attached to a single phrase) every real quote lands
 * inside one text node, so this restriction is the simpler-and-correct
 * choice. The fallback if a caller really needs cross-block matching
 * later is a `textBetween`-then-resolve pass; we'd add it as a
 * separate function rather than complicating this one.
 *
 * Returns null on empty input or no match. Callers surface the
 * `anchor_not_found` reason from there.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

export interface QuoteAnchor {
  from: number
  to: number
}

export function findQuoteInDoc(view: EditorView, quote: string): QuoteAnchor | null {
  return findQuoteInNode(view.state.doc, quote)
}

/** Exported separately so tests can pass a raw PM Node without
 * standing up a full EditorView. */
export function findQuoteInNode(doc: PMNode, quote: string): QuoteAnchor | null {
  if (quote.length === 0) return null

  let result: QuoteAnchor | null = null
  doc.descendants((node, pos) => {
    if (result) return false
    if (!node.isText || !node.text) return undefined
    const idx = node.text.indexOf(quote)
    if (idx === -1) return undefined
    result = { from: pos + idx, to: pos + idx + quote.length }
    return false
  })
  return result
}

/** Read the live text at a PM range. Used by accept() to compare
 * against `mark.quote` for drift detection. Uses textBetween with
 * an empty block separator because we anchor inside one text node
 * (see findQuoteInDoc), so block boundaries should never appear
 * inside the range. */
export function readQuoteAt(view: EditorView, from: number, to: number): string {
  return view.state.doc.textBetween(from, to, '')
}
