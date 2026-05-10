// Single source of truth for "the position right after the top-level
// block that contains `pos`". Used by both the suggestion preview
// (markDecoPlugin) and the accept path (markActions) so the ghost
// widget and the actual inserted content land at the exact same
// place — no pre/post asymmetry when the anchor sits inside a
// blockquote / list / heading wrapper.
//
// depth=1 because depth 0 is the doc itself; the top-level block
// (paragraph / blockquote / heading / list / etc.) is always at
// depth 1. `.end(1)` is the last inline pos of that top-level block;
// +1 steps past its closing token to the sibling slot.

import type { Node } from '@milkdown/kit/prose/model'

export function topLevelSiblingAfter(doc: Node, pos: number): number {
  const $pos = doc.resolve(pos)
  return Math.min($pos.end(1) + 1, doc.content.size)
}
