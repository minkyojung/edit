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

export function deriveLabel(fragment: Y.XmlFragment): string {
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (SKIP_BLOCK_NODES.has(child.nodeName)) continue
    const text = collectText(child).trim()
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
      out += child.toString()
    } else if (child instanceof Y.XmlElement) {
      out += collectText(child)
    }
    // Bail early on pathological inputs (e.g. a single huge text node).
    if (out.length >= MAX_LEN * 2) break
  }
  return out
}
