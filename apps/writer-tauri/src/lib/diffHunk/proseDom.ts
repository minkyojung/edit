// Prose-style diff hunk — vanilla DOM builder.
//
// Renders before / after strings as tinted blocks whose bodies are
// mounted through the LIVE editor's parser + DOMSerializer. The
// body inherits the editor's typography 1:1 (fonts, headings,
// wikilink colour, blockquote stripe) so "this is what the change
// will look like" reads as a true preview.
//
// Density: the block is FLAT — no padded card around it. We attach
// a `pending-edit-tone--{add|remove}` class and let CSS apply the
// bg tint directly to the inner rendered elements (paragraphs,
// headings, etc.). That way a single-line addition occupies one
// editor line, not a 50px tall card. CSS lives in index.css.
//
// Fallback: when the editor isn't mounted (boot, hot reload, panel
// opened before any page was visited), `renderMarkdownViaProseMirror`
// returns `{ ok: false }` and we fall back to the mini-renderer.

import { renderMarkdownToFragment } from '@/lib/renderMarkdownInline'
import { renderMarkdownViaProseMirror } from '@/lib/renderProseMirrorMarkdown'

/** Build the DOM body for a Prose-style diff hunk. Returns a
 * DocumentFragment containing zero, one, or two tinted blocks. */
export function buildDiffHunkProseBody(
  before: string | undefined,
  after: string | undefined,
): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (before) frag.appendChild(buildToneBlock(before, 'remove'))
  if (after) frag.appendChild(buildToneBlock(after, 'add'))
  return frag
}

function buildToneBlock(markdown: string, tone: 'add' | 'remove'): HTMLElement {
  // Single flat `.ProseMirror` host with a tone modifier. CSS
  // (`.pending-edit-tone--{tone}`) paints the inner paragraphs /
  // headings with bg tint and resets their margins so the block
  // hugs the editor's natural line height.
  const body = document.createElement('div')
  body.className = `ProseMirror pending-edit-tone pending-edit-tone--${tone}`
  body.style.minHeight = '0'
  body.style.cursor = 'default'

  const pm = renderMarkdownViaProseMirror(markdown)
  if (pm.ok) body.appendChild(pm.dom)
  else body.appendChild(renderMarkdownToFragment(markdown))

  return body
}
