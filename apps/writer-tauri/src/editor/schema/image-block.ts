// Block-level image node.
//
// Commonmark's `image` is inline — markdown `![alt](src)` parses
// into an inline atom inside a paragraph. That matches the spec for
// "image referenced in flowing text" but disagrees with the
// visual / intent model when the image is the only content on a
// line: full-width rendering, occupies its own block, user expects
// the next line to be a fresh textblock where `- `, `# `, `> `
// input rules fire normally.
//
// Phase 6 introduces `imageBlock` as a parallel node that is a real
// block: `group: 'block'`, atom, with the same `<img>` rendering and
// attrs as the inline cousin. The inline `image` is left untouched
// so commonmark parsing of inline images inside text (e.g.
// "see this ![icon](icon.png) here") stays as it was.
//
// Markdown round-trip:
//   - On save: this node's `toMarkdown` runner wraps the image in a
//     paragraph in the mdast tree so commonmark serializes it as
//     `![alt](src)` on its own line (mdast `image` is always a
//     phrasing content node; it needs a parent block).
//   - On load: commonmark parses `![alt](src)` on its own line as
//     `paragraph(image)`. A post-parse transform in
//     `seedMarkdown.ts` then unwraps `paragraph(only image)` into a
//     top-level `imageBlock`. So round-trip is `imageBlock` →
//     markdown line → `paragraph(image)` → `imageBlock`.
//
// The two-node design keeps round-trip with external markdown tools
// intact (vim, GitHub, Obsidian all see `![alt](src)` — neither
// inline nor block flavour of our internal representation leaks
// into the file format).

import { $nodeSchema } from '@milkdown/kit/utils'

// `draggable` is left at PM's default, which for `atom: true` nodes
// resolves to true (see PM NodeSpec docs). That gives the card a
// schema-driven drag entry: on mousedown PM's `mightDrag` arms, the
// outer DOM gets `draggable="true"` until mouseup, and PM's global
// dragstart handler takes care of NodeSelection + serializeForClipboard
// + view.dragging. BaseCardNodeView only intercepts dragstart to
// swap in a WKWebView-safe canvas preview.
export const imageBlockSchema = $nodeSchema('imageBlock', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '', validate: 'string' },
    alt: { default: '', validate: 'string' },
    title: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      tag: 'img[data-block="true"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        return {
          src: dom.getAttribute('src') || '',
          alt: dom.getAttribute('alt') || '',
          title: dom.getAttribute('title') || '',
        }
      },
    },
  ],
  toDOM: (node) => ['img', { ...node.attrs, 'data-block': 'true' }],
  // No mdast type maps to imageBlock — commonmark only knows the
  // inline `image`. The post-parse unwrap in seedMarkdown converts
  // `paragraph(only image)` to imageBlock at load time, so we don't
  // need a parser runner here. Match returns false to keep this
  // node out of the parser's dispatch table entirely.
  parseMarkdown: {
    match: () => false,
    runner: () => {
      // never called
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'imageBlock',
    runner: (state, node) => {
      // Wrap in paragraph so the mdast tree is well-formed:
      // `image` is phrasingContent, not blockContent. The serialised
      // result is a single line `![alt](src)` followed by the usual
      // paragraph-trailing blank line.
      state.openNode('paragraph')
      state.addNode('image', undefined, undefined, {
        url: node.attrs.src,
        alt: node.attrs.alt,
        title: node.attrs.title,
      })
      state.closeNode()
    },
  },
}))
