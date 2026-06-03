// Block-level "GitHub activity" anchor. The markdown file stores only a
// tiny stable marker — `<div data-github-activity="2026-06-03"></div>` —
// and GitHubActivityCardNodeView renders the live card by reading
// events.db for that date. The volatile commit/PR data is never written
// to disk, so the note stays clean and corrections reflect automatically.
//
// Round-trip strategy mirrors audio-block.ts: CommonMark has no native
// node for this, but remark parses raw HTML blocks as mdast `html` nodes
// with the full tag in `.value`, which we match on parse and re-emit on
// serialize. A plain `<div>` is invisible-but-harmless in Obsidian.

import { $nodeSchema } from '@milkdown/kit/utils'

const ATTR = 'data-github-activity'

/** Escape characters that would break out of a double-quoted attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pull the date out of a raw `<div data-github-activity="...">` tag. */
function readDate(tag: string): string {
  const m = /data-github-activity\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

export const githubActivityBlockSchema = $nodeSchema('githubActivity', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    date: { default: '', validate: 'string' },
  },
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
    match: (node) =>
      node.type === 'html' &&
      typeof node.value === 'string' &&
      /^\s*<div[^>]*data-github-activity/i.test(node.value),
    runner: (state, node, type) => {
      const value = String((node as { value?: unknown }).value ?? '')
      state.addNode(type, { date: readDate(value) })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'githubActivity',
    runner: (state, node) => {
      const date = String(node.attrs.date ?? '')
      state.addNode('html', undefined, undefined, {
        value: `<div data-github-activity="${escapeAttr(date)}"></div>`,
      })
    },
  },
}))
