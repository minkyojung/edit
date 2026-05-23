// Block-level video node — parallel to `imageBlock`, but the
// markdown round-trip goes through raw HTML rather than the
// `![alt](src)` shorthand (commonmark has no native video atom).
//
// Markdown shape: a single `<video src="…" controls></video>` line.
// CommonMark allows raw HTML blocks, and remark parses them as mdast
// `html` nodes with the full tag string in `.value`. Milkdown's
// commonmark preset registers an `html` node type but no
// parseMarkdown runner, so without this schema the html node is
// silently dropped during conversion to PM — leaving the user with
// an empty document where the video used to be. This schema's
// `parseMarkdown.match` claims any mdast html node that starts with
// `<video ` so it lands in PM as a `videoBlock` atom, and the
// matching `toMarkdown.runner` emits an html mdast node back.
//
// Inline `<video>` tags (mid-paragraph) are parsed by remark as
// `html` *phrasing* content, which our match also catches at the
// surface level, but since `videoBlock` is `group: 'block'` the
// resulting node won't fit inside a paragraph — milkdown drops it.
// That's the correct outcome: inline video tags aren't a meaningful
// shape, the user almost certainly meant a block.
//
// Why not extend the commonmark preset's html node directly: it's
// shared across every kind of raw HTML (script, div, span, …) and
// hijacking it for video alone would break those. A dedicated atom
// with a narrow regex is the surgical fix.

import { $nodeSchema } from '@milkdown/kit/utils'

/** Escape the four characters that would break out of an HTML
 * attribute when interpolated unquoted into `src="…"`. `'` doesn't
 * need escaping because we always emit double-quoted attributes. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Pull a quoted attribute value out of a raw HTML tag string.
 * Returns the unescaped raw value (good enough for src/title — we
 * don't need HTML-entity decoding on what's effectively a file path
 * we just wrote). */
function readAttr(tag: string, name: string): string {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  )
  const m = re.exec(tag)
  return m ? (m[1] ?? m[2] ?? '') : ''
}

// `draggable` is left at PM's default — see the matching comment in
// image-block.ts. With `atom: true` PM resolves draggable to true,
// which gives the card its schema-driven drag entry.
export const videoBlockSchema = $nodeSchema('videoBlock', () => ({
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
      tag: 'video[data-block="true"]',
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
    'video',
    {
      ...node.attrs,
      'data-block': 'true',
      controls: '',
    },
  ],
  // Match remark-emitted mdast `html` nodes whose value opens with a
  // `<video` tag. Leading whitespace is tolerated (e.g. indented
  // markdown blocks). The runner pulls src/title out of the tag with
  // a small regex — we don't need a full HTML parser for two attrs.
  parseMarkdown: {
    match: (node) =>
      node.type === 'html' &&
      typeof node.value === 'string' &&
      /^\s*<video[\s>]/i.test(node.value),
    runner: (state, node, type) => {
      const value = String((node as { value?: unknown }).value ?? '')
      const src = readAttr(value, 'src')
      const title = readAttr(value, 'title')
      state.addNode(type, { src, title })
    },
  },
  // Serialise back to a single `<video src="…" controls></video>`
  // line by emitting an mdast `html` node — remark-stringify writes
  // its `.value` through verbatim.
  toMarkdown: {
    match: (node) => node.type.name === 'videoBlock',
    runner: (state, node) => {
      const src = String(node.attrs.src ?? '')
      const title = String(node.attrs.title ?? '')
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
      state.addNode('html', undefined, undefined, {
        value: `<video src="${escapeAttr(src)}"${titleAttr} controls></video>`,
      })
    },
  },
}))
