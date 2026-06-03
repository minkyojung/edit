// Block-level "GitHub activity" anchor. The markdown file stores only a
// tiny stable marker; GitHubActivityCardNodeView renders the live card by
// reading events.db for that date. The volatile commit/PR data is never
// written to disk, so the note stays clean and corrections reflect
// automatically.
//
// Storage = a fenced code block:
//
//     ```github-activity
//     2026-06-03
//     ```
//
// This is the canonical "anchor that renders live" pattern (Obsidian
// Dataview / Mermaid; matches this codebase's CodeBlockVizNodeView). Code
// fences round-trip reliably through CommonMark — unlike the raw `<div>`
// HTML we tried first, which silently failed to re-parse and accumulated
// duplicate text on every reload.
//
// parseMarkdown deliberately claims nothing: a fence first parses as a
// `code_block` (code_block-ext owns every `code` mdast node), then
// seedMarkdown's post-parse transform lifts `code_block(language=
// github-activity)` into this node — exactly how imageBlock is lifted
// from `paragraph(image)`. So the round-trip is: node → fence (toMarkdown)
// → code_block (parse) → node (transform).

import { $nodeSchema } from '@milkdown/kit/utils'

const ATTR = 'data-github-activity'

export const githubActivityBlockSchema = $nodeSchema('githubActivity', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    date: { default: '', validate: 'string' },
  },
  // parseDOM/toDOM only matter for clipboard HTML; the markdown round-trip
  // goes through the code fence (toMarkdown) + post-parse transform.
  parseDOM: [
    {
      tag: `div[${ATTR}]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        return { date: dom.getAttribute(ATTR) || '' }
      },
    },
  ],
  toDOM: (node) => ['div', { [ATTR]: String(node.attrs.date ?? '') }],
  parseMarkdown: {
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node) => node.type.name === 'githubActivity',
    runner: (state, node) => {
      const date = String(node.attrs.date ?? '')
      // Emit a fenced code block: ```github-activity\n<date>\n```
      state.addNode('code', undefined, date, { lang: 'github-activity' })
    },
  },
}))
