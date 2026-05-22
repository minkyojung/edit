/**
 * Seed a Y.Doc's prosemirror fragment from a markdown string.
 *
 * Used by createCustomWikiPage and ensureSystemPage to plant initial
 * body content into a freshly-created doc — the role proof-server's
 * `createDoc(name, body)` used to fill before Phase 3.B removed the
 * round-trip. Without this helper the `body` argument is silently
 * dropped, which is what surfaced as "new wiki pages are blank" and
 * "conventions page is empty (LLM ignores routing rules)".
 *
 * Flow:
 *   markdown
 *     → PM Node (Milkdown parser, shares the editor schema)
 *     → temp Y.Doc (y-prosemirror's prosemirrorToYDoc)
 *     → state binary update
 *     → applied to the target Y.Doc under 'doc-init' origin
 *
 * The 'doc-init' origin keeps this write out of the UndoManager (
 * same convention as the empty-fragment fill in MilkdownEditor.tsx:
 * 280-292), so Cmd+Z right after opening a fresh page doesn't
 * strip the seeded content.
 *
 * The temp Y.Doc is destroyed after the update is encoded — its
 * sole purpose is to give prosemirrorToYDoc a clean target so we
 * can extract a self-contained update to merge into the real doc.
 */

import * as Y from 'yjs'
import { prosemirrorToYDoc } from 'y-prosemirror'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { MarkdownParser } from '@/state/editorViewStore'

const FRAGMENT_NAME = 'prosemirror'
const ORIGIN = 'doc-init'

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

/** Returns true on success. False when the parser returns no node
 * (empty / whitespace-only markdown) — callers can treat that as
 * "nothing to seed" rather than an error. */
export function seedMarkdownIntoYDoc(
  ydoc: Y.Doc,
  markdown: string,
  parser: MarkdownParser,
): boolean {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return false

  let pmNode: ReturnType<MarkdownParser>
  try {
    pmNode = parser(trimmed)
  } catch (err) {
    console.warn('[seedMarkdown] parser failed', err)
    return false
  }
  if (!pmNode) return false

  const transformed = unwrapBlockImages(pmNode)
  const seedDoc = prosemirrorToYDoc(transformed, FRAGMENT_NAME)
  const update = Y.encodeStateAsUpdate(seedDoc)
  try {
    Y.applyUpdate(ydoc, update, ORIGIN)
  } finally {
    seedDoc.destroy()
  }
  return true
}

/** Replace the entire body of a Y.Doc's prosemirror fragment with
 * the parsed markdown. Used by the profile pipeline so a fresh
 * pipeline run (full or single-zone re-derivation) can rewrite the
 * page contents, where {@link seedMarkdownIntoYDoc} would no-op
 * because the doc already has content.
 *
 * Two-phase write: clear the existing fragment, then apply the new
 * state from a temp doc. Both phases use the same 'doc-init' origin
 * so the rewrite stays out of the user's undo stack. The two
 * transactions are sequential (Yjs nesting is fine but two flat
 * transactions are simpler to reason about); no concurrent observer
 * will see the doc in the intermediate "empty" state on the same
 * tick. */
export function replaceMarkdownInYDoc(
  ydoc: Y.Doc,
  markdown: string,
  parser: MarkdownParser,
): boolean {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return false

  let pmNode: ReturnType<MarkdownParser>
  try {
    pmNode = parser(trimmed)
  } catch (err) {
    console.warn('[seedMarkdown] replace: parser failed', err)
    return false
  }
  if (!pmNode) return false

  const transformed = unwrapBlockImages(pmNode)
  const fragment = ydoc.getXmlFragment(FRAGMENT_NAME)
  const seedDoc = prosemirrorToYDoc(transformed, FRAGMENT_NAME)
  const update = Y.encodeStateAsUpdate(seedDoc)

  try {
    ydoc.transact(() => {
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length)
      }
    }, ORIGIN)
    Y.applyUpdate(ydoc, update, ORIGIN)
  } finally {
    seedDoc.destroy()
  }
  return true
}
