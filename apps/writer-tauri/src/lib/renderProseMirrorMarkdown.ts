// Render a markdown snippet through the LIVE editor's parser +
// ProseMirror's DOMSerializer so the resulting DOM is byte-for-byte
// what the user sees inside the editor.
//
// Why this exists: review surfaces (Review Panel diff preview,
// future inline highlight tooltip, etc.) need to show "what the
// content will look like after this change lands". A separate
// markdown→DOM utility (lib/renderMarkdownInline) covers compact
// row previews where Linear-style density matters more than
// pixel-perfect editor parity. For the expanded diff card we
// actually want pixel parity — same fonts, same heading sizes,
// same wikilink colour, same blockquote left-stripe — so we go
// through the editor's own machinery.
//
// Flow:
//   1. `useEditorViewStore.getState().parser` — the wrapped parser
//      from MilkdownEditor (Phase L1: `[[Title]]` → link mark).
//   2. `parser(md)` produces a PM Node.
//   3. The Node carries its schema reference (`.type.schema`).
//   4. `DOMSerializer.fromSchema(schema)` builds the same serializer
//      the editor uses to turn PM nodes into DOM. Calling
//      `serializeFragment` on the parsed content emits a DocumentFragment
//      whose markup matches the editor's `.ProseMirror` body.
//   5. The caller wraps that fragment in a `.ProseMirror` host so
//      the editor's CSS rules apply transparently.
//
// Fallback: when no editor is mounted yet (boot, hot reload, etc.)
// the parser is null and we return `ok: false`. The caller falls
// back to lib/renderMarkdownInline for a "close enough" preview.

import { DOMSerializer } from '@milkdown/kit/prose/model'
import { useEditorViewStore } from '@/state/editorViewStore'

export type ProseMirrorRender =
  | { ok: true; dom: DocumentFragment }
  | { ok: false }

/** Render `md` through the editor's parser + DOMSerializer. Returns
 * `{ ok: false }` when the parser hasn't been published yet (no
 * editor mounted in this session). */
export function renderMarkdownViaProseMirror(md: string): ProseMirrorRender {
  const parser = useEditorViewStore.getState().parser
  if (!parser) return { ok: false }
  let parsed
  try {
    parsed = parser(md)
  } catch (err) {
    console.warn('[render:pm] parse failed', err)
    return { ok: false }
  }
  if (!parsed || parsed.content.size === 0) return { ok: false }
  const schema = parsed.type.schema
  const serializer = DOMSerializer.fromSchema(schema)
  // `window.document` is the implicit default for DOMSerializer in
  // browser builds; pass it explicitly so the helper also works
  // inside jsdom-based unit tests if we ever add some.
  // `serializeFragment` returns `HTMLElement | DocumentFragment` in
  // the type defs, but for a Fragment input it's always a
  // DocumentFragment. The cast keeps the caller's API simple.
  const dom = serializer.serializeFragment(parsed.content, {
    document,
  }) as DocumentFragment
  return { ok: true, dom }
}
