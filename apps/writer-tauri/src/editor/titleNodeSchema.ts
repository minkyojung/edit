// Compatibility-only schema for the retired `title` node experiment.
//
// We briefly shipped a custom `title` node with isolating + defining
// to give the doc's title slot a schema-level boundary. The
// experiment was reverted (see the revert(title) commit) because the
// server's collab pipeline didn't understand the type — every edit
// inside a title node would round-trip through the server and come
// back as a revert.
//
// THIS FILE EXISTS ONLY SO THAT DOCS WHOSE Yjs FRAGMENT STILL HAS
// `<title>` ELEMENTS CAN STILL LOAD. Without a matching PM schema
// type, y-prosemirror would throw when it tries to instantiate a
// node it doesn't recognize during sync. With this no-op type
// registered, those docs load cleanly, then the cleanup pass in
// lib/docTitle.ts (`scrubStrayTitleNodes`) converts every title
// node to a heading level=1 on first sync.
//
// Key differences from the original experimental schema:
//
//   - NO `isolating: true`     — title nodes behave like ordinary
//                                blocks while they exist, so Enter
//                                inside one creates a paragraph
//                                sibling (PM's defining-block
//                                fallback) instead of another title.
//                                This kills the splitBlock loop that
//                                was the root cause of the revert.
//   - NO `defining: true`      — same reasoning. Less PM magic, more
//                                predictable behavior during the
//                                cleanup window.
//   - NO custom parseDOM        — we don't want clipboard paste of
//                                arbitrary h1 markup to create new
//                                title nodes. The only way to land
//                                here is via stray Yjs data from the
//                                experiment.
//   - toDOM is plain h1        — visually identical to a heading so
//                                the user doesn't see a phantom
//                                style during the brief window
//                                before cleanup runs.
//
// Once we have confirmation that no docs carry stray <title> Yjs
// elements (verifiable via the editorDebug snapshot), this file and
// its `.use(titleNodeSchema)` registration can be removed entirely.

import { $nodeSchema } from '@milkdown/kit/utils'

export const titleNodeSchema = $nodeSchema('title', () => ({
  content: 'inline*',
  group: 'block',
  parseDOM: [],
  toDOM: () => ['h1', 0],
  parseMarkdown: {
    match: () => false,
    runner: () => {
      /* never invoked */
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'title',
    runner: (state, node) => {
      // Emit as `# X` so any markdown export round-trips cleanly
      // even before cleanup runs.
      state.openNode('heading', undefined, { depth: 1 })
      state.next(node.content)
      state.closeNode()
    },
  },
}))
