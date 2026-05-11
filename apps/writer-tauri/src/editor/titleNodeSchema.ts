// Custom 'title' node — the doc's title slot, physically separate from
// regular headings.
//
// Why a dedicated node instead of "first h1 by convention":
//   - `isolating: true` makes ProseMirror REFUSE to merge this node with
//     adjacent blocks. Backspace at the start of an empty title is a
//     no-op (the node can't be deleted into the previous block — there
//     is none); Backspace at the start of the body paragraph that
//     follows the title also can't merge across the title boundary.
//     The single-source-of-truth "title = first h1" was structurally
//     vulnerable to exactly that merge.
//   - `defining: true` preserves the node's identity when its content
//     is replaced (so paste/replace operations don't accidentally
//     downgrade title → paragraph mid-edit).
//   - Distinct node name lets every consumer (placeholder, docTitle
//     reader, headingKeymap, format toolbar, slash menu) opt in
//     explicitly rather than relying on "is this a heading? is its
//     level 1? is it the first child?" — three conditions that need
//     to stay synchronized everywhere.
//
// Markdown round-trip:
//   - parseMarkdown is intentionally NOT defined here. We let
//     commonmark's heading parser own all `#` markdown (depths 1-6),
//     and the doc-init migration (lib/docTitle.ts) converts the first
//     `heading{level:1}` at position 0 into a title node. This avoids
//     parser-priority issues between competing handlers and keeps the
//     "title only exists at doc[0]" invariant in one place
//     (migration), not scattered across parser rules.
//   - toMarkdown emits `# X` so exporting / copying as markdown
//     produces a normal h1 — round-trips to any other markdown tool.

import { $nodeSchema } from '@milkdown/kit/utils'

export const titleNodeSchema = $nodeSchema('title', () => ({
  content: 'inline*',
  group: 'block',
  defining: true,
  isolating: true,
  parseDOM: [
    // Round-trips from our own DOM output (paste back into another
    // editor instance, for example). External markdown / HTML still
    // arrives as plain h1 and is normalized to title during migration.
    { tag: 'h1[data-title]' },
  ],
  toDOM: () => [
    'h1',
    { 'data-title': '', class: 'doc-title' },
    0,
  ],
  // Required by Milkdown's NodeSchema type but intentionally a no-op:
  // commonmark's heading parser owns every `#` in the markdown AST.
  // The first-h1 → title conversion happens in the doc-init migration,
  // not in the parser, so we don't compete here.
  parseMarkdown: {
    match: () => false,
    runner: () => {
      /* never invoked */
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'title',
    runner: (state, node) => {
      state.openNode('heading', undefined, { depth: 1 })
      state.next(node.content)
      state.closeNode()
    },
  },
}))
