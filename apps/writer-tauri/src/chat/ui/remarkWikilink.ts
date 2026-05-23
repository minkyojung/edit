// Recognise `[[Title]]` tokens in chat answer text and convert them
// into a standard `<a>` element carrying `data-wikilink-*` markers.
// The conversion runs at the mdast layer so the token is identified
// as a wikilink before any rehype plugin runs; the standard element
// name (`<a>`) means rehype-sanitize, rehype-harden, and any future
// safety plugin streamdown might ship keep the node intact instead
// of stripping it.
//
// We used to emit a non-standard `<wikilink>` element. That worked
// against rehype-harden but tripped rehype-sanitize, which defaults
// to allowing only standard HTML element names and silently dropped
// our element + its children. Standard element + `data-*` attribute
// is the unified-ecosystem convention for "ordinary element with our
// specific meaning attached" (same shape GitHub task lists, MDX
// wikilink plugins, etc. use).
//
// Title resolution mirrors `lib/wikilinkResolve.ts::resolveWikilinksInMarkdown`:
//   - lowercase exact match against non-archived, non-system docs
//   - on miss, the node still renders (carrying `data-wikilink-broken="true"`)
//     so the user sees the intended reference instead of silently
//     losing the brackets. The matching React component renders
//     broken entries as muted, non-clickable text.

import type { Plugin } from 'unified'
import type { Root, Text, PhrasingContent } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'
import { useDocsStore } from '@/state/docsStore'

// Same regex `wikilinkResolve.ts` uses — keep symmetric so doc-side
// and chat-side accept the exact same input shape.
const PATTERN = /\[\[([^\]\n]+)\]\]/g

export const remarkWikilink: Plugin<[], Root> = () => {
  return (tree) => {
    const titleToSlug = buildTitleIndex()
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || typeof index !== 'number') return
      const value = (node as Text).value
      // Fast path: no token in this text node, nothing to do.
      PATTERN.lastIndex = 0
      if (!PATTERN.test(value)) {
        PATTERN.lastIndex = 0
        return
      }
      PATTERN.lastIndex = 0

      const replacements = splitTextNode(value, titleToSlug)
      if (replacements.length === 1 && replacements[0].type === 'text') {
        // Nothing actually changed (only matched on the test pass).
        return
      }
      parent.children.splice(index, 1, ...replacements)
      // Skip the freshly inserted nodes so we don't recurse into the
      // text children of a wikilink we just produced.
      return [SKIP, index + replacements.length]
    })
  }
}

/** Split a single text value into a sequence of text + wikilink
 * nodes. Pure function, easier to reason about than mutating in place
 * inside the visitor callback. */
function splitTextNode(
  value: string,
  titleToSlug: Map<string, string>,
): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let cursor = 0
  PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATTERN.exec(value)) !== null) {
    const title = m[1].trim()
    if (m.index > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, m.index) })
    }
    const slug = title ? titleToSlug.get(title.toLowerCase()) : undefined
    // Emit a standard <a> element with data-* markers. mdast-util-to-hast
    // honours `data.hName` + `data.hProperties` to produce the matching
    // hast element; rehype-sanitize keeps standard elements + data
    // attributes intact, so the React component map sees this node
    // with its children intact (unlike the prior <wikilink> attempt).
    const wikilink = {
      type: 'wikilink',
      data: {
        hName: 'a',
        hProperties: {
          href: '#',
          'data-wikilink-slug': slug ?? '',
          'data-wikilink-broken': slug ? 'false' : 'true',
        },
      },
      children: [{ type: 'text', value: title }],
    }
    out.push(wikilink as unknown as PhrasingContent)
    cursor = m.index + m[0].length
  }
  PATTERN.lastIndex = 0
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) })
  }
  return out
}

/** Build the title → slug map used to resolve a `[[Title]]` token.
 * Filters mirror `wikilinkResolve.ts`: skip archived docs and skip
 * system pages (agent meta surfaces the user isn't expected to link
 * to). First match wins on title collisions — same policy. */
function buildTitleIndex(): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of useDocsStore.getState().knownDocs) {
    if (d.archivedAt) continue
    if (d.type.startsWith('system:')) continue
    const title = (d.title ?? '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (!out.has(key)) out.set(key, d.slug)
  }
  return out
}
