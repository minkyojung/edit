/**
 * PM-native body seeding / replacement helpers.
 *
 * Phase 5c of the Yjs-removal migration retired the Y.Doc-based
 * helpers (`seedMarkdownIntoYDoc`, `replaceMarkdownInYDoc`,
 * `applyYDocBinaryAtomically`) that this module used to ship.
 * `applyMarkdownToEditor` is now the single canonical path: parse
 * the markdown, rehydrate against the live editor's schema, dispatch
 * one non-undoable PM transaction that swaps the entire doc.
 *
 * Atomicity:
 *   `view.dispatch` of a single `tr.replaceWith` is one transaction —
 *   plugins see the post-transaction state only, never a partial.
 *   The `addToHistory: false` meta keeps the swap out of Cmd-Z so a
 *   stray undo after, say, a profile rebuild can't leave the doc in
 *   a half-rewritten state.
 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { MarkdownParser } from '@/state/editorViewStore'

/** Convert top-level `paragraph(only image)` blocks into the
 * dedicated `imageBlock` node. Commonmark only knows the inline
 * `image` mdast type, so a standalone image on its own line in the
 * markdown source parses as `paragraph(image)`. We treat that
 * structural shape as the user's intent of "image on its own line"
 * and lift it to a real block node so input rules, navigation, and
 * the visual model stay consistent with the doc model.
 *
 * Inline-image-in-text (e.g. `see this ![icon](icon.png) here`)
 * stays as commonmark intended — the unwrap only fires for
 * paragraphs whose ONLY child is an image, which is exactly the
 * "image alone on a line" markdown shape. */
function unwrapBlockImages(doc: PMNode): PMNode {
  const imageBlockType = doc.type.schema.nodes.imageBlock
  if (!imageBlockType) return doc
  const next: PMNode[] = []
  let changed = false
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i)
    if (
      child.type.name === 'paragraph' &&
      child.childCount === 1 &&
      child.firstChild?.type.name === 'image'
    ) {
      const img = child.firstChild
      next.push(
        imageBlockType.create({
          src: img.attrs.src,
          alt: img.attrs.alt,
          title: img.attrs.title,
        }),
      )
      changed = true
    } else {
      next.push(child)
    }
  }
  if (!changed) return doc
  return doc.type.create(doc.attrs, next)
}

/** Drop standalone `<br />` lines from a markdown blob before it
 * reaches the parser. Commonmark + gfm parse `<br />` as inline HTML
 * and our PM schema has no node for raw HTML inline — so they fell
 * through to literal text after the Phase 5a Step 8 switch from the
 * Y.Doc fragment hydrate to the markdown parser. These tags live in
 * legacy daily-doc bodies (a structural separator pattern from an
 * earlier seed routine) and AI Edit calls preserve them as
 * unchanged context, so without this strip every external reload
 * paints `<br />` into the body verbatim.
 *
 * Self-healing: stripping at parse time means PM never sees the
 * tags, so the next `flushDirty` round writes a `.md` without them
 * and the noise fades on its own. */
export function stripNoiseMarkdownLines(markdown: string): string {
  if (!markdown.includes('<br')) return markdown
  return markdown
    .split('\n')
    .filter((line) => !/^<br\s*\/?>$/i.test(line.trim()))
    .join('\n')
}

export function applyMarkdownToEditor(
  view: EditorView,
  markdown: string,
  parser: MarkdownParser,
): boolean {
  const trimmed = stripNoiseMarkdownLines(markdown).trim()
  if (trimmed.length === 0) return false

  let parsed: ReturnType<MarkdownParser>
  try {
    parsed = parser(trimmed)
  } catch (err) {
    console.warn('[seedMarkdown] applyMarkdownToEditor: parser failed', err)
    return false
  }
  if (!parsed) return false

  const transformed = unwrapBlockImages(parsed)
  // Schema-rehydration: the parser comes from the headless Milkdown
  // (lib/headlessMilkdown.ts) which builds its OWN PM schema instance.
  // The live EditorView has a separate schema instance — structurally
  // identical, but a different object. PM compares `node.type` by
  // reference, so dispatching nodes from the headless schema into the
  // live view silently no-ops the replace. Round-tripping via toJSON
  // → schema.nodeFromJSON rebuilds the tree against the live schema,
  // which is the only thing the live view accepts.
  let liveNode
  try {
    liveNode = view.state.schema.nodeFromJSON(transformed.toJSON())
  } catch (err) {
    console.warn(
      '[seedMarkdown] applyMarkdownToEditor: schema rehydrate failed',
      err,
    )
    return false
  }
  view.dispatch(
    view.state.tr
      .replaceWith(0, view.state.doc.content.size, liveNode.content)
      .setMeta('addToHistory', false),
  )
  return true
}
