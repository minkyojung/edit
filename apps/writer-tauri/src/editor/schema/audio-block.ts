// Block-level audio node — parallel to videoBlock. Same round-trip
// strategy via raw HTML: CommonMark has no native audio atom, but it
// does permit raw `<audio>` blocks, and remark parses them as mdast
// `html` nodes with the full tag string in `.value`.
//
// Markdown shape: `<audio src="…" title="…" controls></audio>`. The
// `title` attribute holds the user's description (the input field
// above the controls in AudioCardNodeView writes here), so external
// readers see what the clip is about even without playback. The
// `controls` attribute is preserved for round-trip readability —
// our NodeView builds its own controls but external viewers will
// still get a working player.
//
// Inline `<audio>` tags (mid-paragraph) are unmeaningful; this
// schema's `block` group + the regex's `^\s*<audio` constraint
// ensure only line-level audio tags become cards.

import { $nodeSchema } from '@milkdown/kit/utils'

/** Escape the four characters that would break out of a double-
 * quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pull a quoted attribute value out of a raw HTML tag string. */
function readAttr(tag: string, name: string): string {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  )
  const m = re.exec(tag)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

// `draggable` is left at PM's default — atom: true resolves it to
// true, which gives the card its schema-driven drag entry just like
// imageBlock / videoBlock.
export const audioBlockSchema = $nodeSchema('audioBlock', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '', validate: 'string' },
    title: { default: '', validate: 'string' },
  },
  parseDOM: [
    {
      tag: 'audio[data-block="true"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false
        return {
          src: dom.getAttribute('src') || '',
          title: dom.getAttribute('title') || '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'audio',
    {
      ...node.attrs,
      'data-block': 'true',
      controls: '',
    },
  ],
  parseMarkdown: {
    match: (node) =>
      node.type === 'html' &&
      typeof node.value === 'string' &&
      /^\s*<audio[\s>]/i.test(node.value),
    runner: (state, node, type) => {
      const value = String((node as { value?: unknown }).value ?? '')
      const src = readAttr(value, 'src')
      const title = readAttr(value, 'title')
      state.addNode(type, { src, title })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'audioBlock',
    runner: (state, node) => {
      const src = String(node.attrs.src ?? '')
      const title = String(node.attrs.title ?? '')
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
      state.addNode('html', undefined, undefined, {
        value: `<audio src="${escapeAttr(src)}"${titleAttr} controls></audio>`,
      })
    },
  },
}))
