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
import type { MarkdownParser } from '@/state/editorViewStore'

const FRAGMENT_NAME = 'prosemirror'
const ORIGIN = 'doc-init'

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

  let pmNode: ReturnType<MarkdownParser> | null = null
  try {
    pmNode = parser(trimmed)
  } catch (err) {
    console.warn('[seedMarkdown] parser failed', err)
    return false
  }
  if (!pmNode) return false

  const seedDoc = prosemirrorToYDoc(pmNode, FRAGMENT_NAME)
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

  let pmNode: ReturnType<MarkdownParser> | null = null
  try {
    pmNode = parser(trimmed)
  } catch (err) {
    console.warn('[seedMarkdown] replace: parser failed', err)
    return false
  }
  if (!pmNode) return false

  const fragment = ydoc.getXmlFragment(FRAGMENT_NAME)
  const seedDoc = prosemirrorToYDoc(pmNode, FRAGMENT_NAME)
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
