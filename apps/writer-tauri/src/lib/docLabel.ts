// Display label derivation for a doc — used by sidebar, tabs,
// breadcrumb, wikilink palette, and anywhere else a doc reference
// needs a short human-readable name.
//
// Replaces the old "first body h1" rule. The h1 no longer has special
// status: the label is just the first non-empty piece of text in the
// body, regardless of whether it's wrapped in a heading, paragraph,
// blockquote, or list. A blank body yields an empty string; callers
// fall back to 'Untitled' in their display layer (single place).
//
// Wikilinks are stored as the standard `link` mark (see
// wikilinkPalettePlugin), so the displayed link text is already plain
// text in the body — no special unwrapping needed here.

import * as Y from 'yjs'

const MAX_LEN = 80
// Block-level nodes whose text content makes no sense as a label.
// code_block: the code itself is not a title. Anything else is fine.
const SKIP_BLOCK_NODES = new Set(['code_block'])
// List nodes: descend into only the first item so a multi-item list
// yields "first item" rather than "first item second item ...".
const LIST_NODES = new Set(['bullet_list', 'ordered_list'])
// Invisible characters older builds seeded into the body to satisfy
// proof-server's now-removed non-empty-markdown guard. Strip them so
// a legacy ZWS-only doc still derives an empty label (and falls back
// to 'Untitled' in the display layer) rather than rendering an
// invisible character in the sidebar.
const INVISIBLE_CHARS_RE = /[​﻿]/g

export function deriveLabel(fragment: Y.XmlFragment): string {
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (SKIP_BLOCK_NODES.has(child.nodeName)) continue
    const text = collectText(child).replace(INVISIBLE_CHARS_RE, '').trim()
    if (text.length === 0) continue
    return text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text
  }
  return ''
}

function collectText(el: Y.XmlElement): string {
  if (SKIP_BLOCK_NODES.has(el.nodeName)) return ''

  const children = el.toArray()
  // Lists: only walk the first child (the first list_item) so we
  // don't concatenate every item into the label.
  const iter = LIST_NODES.has(el.nodeName)
    ? children.slice(0, 1)
    : children

  let out = ''
  for (const child of iter) {
    if (child instanceof Y.XmlText) {
      out += extractPlainText(child)
    } else if (child instanceof Y.XmlElement) {
      out += collectText(child)
    }
    // Bail early on pathological inputs (e.g. a single huge text node).
    if (out.length >= MAX_LEN * 2) break
  }
  return out
}

/** Pull the plain-text insert payload from a Y.XmlText, ignoring all
 * inline marks.
 *
 * Why this matters: `Y.XmlText.toString()` serializes inline marks as
 * raw XML wrappers (e.g. `<proofAuthored by="ai:wiki-ingest">…</...>`).
 * Sidebar labels and tab titles render that string directly, so a
 * proof-marked first line surfaced as the literal `<proofAuthored …>`
 * tag in the UI. Yjs's `toDelta()` returns the ordered ops with marks
 * separated into `attributes`; we keep only the inserts and drop the
 * mark metadata so what ships to the UI is the same characters the
 * user sees in the editor. */
function extractPlainText(text: Y.XmlText): string {
  const ops = (text as Y.Text).toDelta() as Array<{
    insert?: unknown
    attributes?: unknown
  }>
  let out = ''
  for (const op of ops) {
    if (typeof op.insert === 'string') out += op.insert
  }
  return out
}
