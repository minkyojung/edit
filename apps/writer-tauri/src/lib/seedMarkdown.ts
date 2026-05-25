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
import type { EditorView } from '@milkdown/kit/prose/view'
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
 * the parsed markdown. Used by the profile pipeline and the ingest
 * reload path to rewrite page contents where {@link seedMarkdownIntoYDoc}
 * would no-op because the doc already has content.
 *
 * **Atomic**: the fragment clear and the new content apply happen
 * inside the same `ydoc.transact(..., 'doc-init')`. This matters
 * because observers (and the MilkdownEditor's mount-time "fragment
 * is empty → fill with a blank paragraph" safety net) see the doc
 * in its post-transact state only — they never observe the
 * intermediate "empty fragment" between the delete and the apply.
 * A previous two-step version of this function caused a race where
 * a mount happening mid-rewrite would mistake the brief empty
 * fragment for a fresh doc and inject a blank paragraph that then
 * survived the apply (because CRDT merge added it on top of the new
 * content), eventually causing the next flush to overwrite the new
 * body with the blank-paragraph state on disk. */
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
      // Y.applyUpdate inside a transact is supported by yjs — the
      // outer transact's origin wins, so this lands as a single
      // 'doc-init' commit that observers see as one event.
      Y.applyUpdate(ydoc, update, ORIGIN)
    }, ORIGIN)
  } finally {
    seedDoc.destroy()
  }
  return true
}

/** PM-native counterpart to {@link seedMarkdownIntoYDoc} /
 * {@link replaceMarkdownInYDoc}. Parses `markdown` and dispatches a
 * single non-undoable transaction that swaps the entire doc content
 * for the parsed result.
 *
 * Why this exists alongside the Y.Doc helpers:
 *   After Phase 3 of the Yjs-removal migration the collab plugin is
 *   gone — Y.Doc mutations no longer propagate into the live PM
 *   EditorState. Callers that want a body rewrite to be visible to
 *   a user actively viewing the doc must dispatch into PM directly;
 *   the Y.Doc helpers are only correct for docs whose editor hasn't
 *   mounted yet (where the mount-time hydrate picks them up).
 *
 *   `applyMarkdownToEditor` covers the "doc is currently mounted"
 *   path. `seedDocBody` / `replaceDocBody` in docsStore pick between
 *   this and the Y.Doc helper at the call site based on whether the
 *   slug matches the active editor view.
 *
 * Atomicity:
 *   `view.dispatch` of a single `tr.replaceWith` is one transaction —
 *   plugins see the post-transaction state only, never a partial.
 *   The `addToHistory: false` meta keeps the swap out of Cmd-Z so a
 *   stray undo after, say, a profile rebuild can't leave the doc in a
 *   half-rewritten state.
 *
 * Returns true on success, false when the parser yields nothing
 * (empty / whitespace-only markdown) — callers treat that as
 * "nothing to apply" rather than an error. */
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

/** Atomic equivalent of "clear fragment + apply a `.ydoc` binary",
 * used by the Tier-1 hydrate path in `applyVaultBodyToYDoc`. Same
 * race rationale as {@link replaceMarkdownInYDoc}: the delete and
 * the apply must land in one transact so a concurrent editor mount
 * can never observe an intermediate empty fragment.
 *
 * Caller is responsible for catching errors — a corrupt `.ydoc` is
 * a recoverable failure (the caller falls back to the markdown
 * tier) so we don't swallow the throw here. */
export function applyYDocBinaryAtomically(
  ydoc: Y.Doc,
  binary: Uint8Array,
): void {
  const fragment = ydoc.getXmlFragment(FRAGMENT_NAME)
  ydoc.transact(() => {
    if (fragment.length > 0) {
      fragment.delete(0, fragment.length)
    }
    Y.applyUpdate(ydoc, binary, ORIGIN)
  }, ORIGIN)
}
