// Render a pending edit IN THE CONTEXT of the page it lives on.
//
// Instead of showing just the changed before/after blocks in
// isolation, we render N surrounding top-level blocks of the page so
// the user reads the change with its immediate context — what comes
// just above, what comes just below — the same way they'd see it
// while writing in the editor.
//
// Pipeline:
//   1. parse the page's `bodyMarkdown` via the editor's parser
//      (same parser the live editor uses; carries [[Wikilink]]
//      handling and any other schema rules)
//   2. walk the doc's top-level children and find the anchor block
//      — the one whose text contains `edit.before` (for replace /
//      delete) or that ends with `edit.anchorBefore` (for add)
//   3. serialize each visible block to DOM via DOMSerializer (the
//      same machinery the editor uses to render its body, so the
//      typography is pixel-identical)
//   4. apply tone tints: anchor block gets `pending-edit-tone--remove`
//      for replace/delete; a synthesized "after" block is rendered
//      and inserted right after the anchor with `pending-edit-tone--add`
//   5. context blocks above and below render plain (no tint)
//
// Returns `null` when the helper can't produce a meaningful render
// (parser unavailable, body empty, anchor not found). Callers fall
// back to the basic two-block DiffHunkProse view.

import { DOMSerializer } from '@milkdown/kit/prose/model'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { PendingEdit } from '@/state/pendingChangesStore'

export interface BuildProseContextArgs {
  /** Vault markdown of the page the edit targets. */
  pageMarkdown: string
  /** The edit to render. */
  edit: PendingEdit
  /** How many top-level blocks to show above and below the anchor.
   * 2 = up to 2 above + the anchor + up to 2 below. */
  contextBlocks: number
}

/** Build the DOM body for an "edit in context" preview. Returns
 * null when the helper can't resolve the anchor — the caller falls
 * back to the simpler DiffHunkProse view. */
export function buildDiffHunkProseInContextBody(
  args: BuildProseContextArgs,
): DocumentFragment | null {
  const { pageMarkdown, edit, contextBlocks } = args

  const parser = useEditorViewStore.getState().parser
  if (!parser) return null
  if (pageMarkdown.length === 0) return null

  let doc: PMNode
  try {
    doc = parser(pageMarkdown)
  } catch (err) {
    console.warn('[proseContext] parse failed', err)
    return null
  }

  const topBlocks: PMNode[] = []
  doc.content.forEach((child) => {
    topBlocks.push(child)
  })
  if (topBlocks.length === 0) return null

  const anchorIdx = findAnchorBlock(topBlocks, edit)
  if (anchorIdx < 0) return null

  const startIdx = Math.max(0, anchorIdx - contextBlocks)
  const endIdx = Math.min(topBlocks.length - 1, anchorIdx + contextBlocks)

  const schema = doc.type.schema
  const serializer = DOMSerializer.fromSchema(schema)

  const frag = document.createDocumentFragment()

  for (let i = startIdx; i <= endIdx; i += 1) {
    const block = topBlocks[i]

    // Each PM child serializes to a single DOM node (the block's
    // outer element — p, h1, ul, etc.). `serializeNode` returns
    // the element directly; we'd otherwise wrap in a Fragment by
    // calling `serializeFragment` over a synthesized single-child
    // fragment. The direct path is cleaner.
    const blockDom = serializer.serializeNode(block)

    if (i === anchorIdx && (edit.kind === 'replace' || edit.kind === 'delete')) {
      // Wrap the anchor block in a tinted host so the existing tone
      // CSS rules (`.pending-edit-tone--remove p { bg: red }` etc.)
      // paint the inner block element.
      frag.appendChild(wrapInToneHost(blockDom, 'remove'))
    } else {
      // Plain context block — wrap in a host with no tone so it
      // sits naturally (margin reset still applies via .pending-edit-tone
      // when we DON'T add the tone modifier). Actually we want the
      // editor's natural paragraph spacing for context, so DON'T
      // wrap in pending-edit-tone — just use a plain .ProseMirror
      // host (so the editor's typography rules apply).
      frag.appendChild(wrapInPlainHost(blockDom))
    }

    // After rendering the anchor, splice in the synthesized "after"
    // block for add / replace.
    if (i === anchorIdx && (edit.kind === 'add' || edit.kind === 'replace')) {
      const after = edit.after
      if (after && after.length > 0) {
        const afterDom = renderMarkdownToDom(after, parser, schema)
        if (afterDom) {
          frag.appendChild(wrapInToneHost(afterDom, 'add'))
        }
      }
    }
  }

  return frag
}

/** Find which top-level block contains the edit's anchor:
 *   - replace / delete: first block whose textContent contains `before`
 *   - add: last block whose textContent ends with `anchorBefore`
 *           (or first block when `anchorBefore` is empty = top of doc;
 *            or last block when no match = append at end)
 * Returns -1 when no block matches (caller treats as stale). */
function findAnchorBlock(blocks: PMNode[], edit: PendingEdit): number {
  if (edit.kind === 'replace' || edit.kind === 'delete') {
    const target = edit.before
    if (!target) return -1
    // textContent strips markdown syntax (bold, links, etc.) — for
    // most chat-edit anchors that's the same string the LLM saw.
    // Imperfect for wikilink-heavy targets but good enough as a
    // first pass; the fallback DiffHunkProse view handles the miss.
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].textContent.includes(target)) return i
    }
    return -1
  }
  // add: anchorBefore is the text just BEFORE the insertion point.
  // Empty anchor = top of doc → anchor at first block; the new
  // content lands after it.
  const anchor = edit.anchorBefore
  if (anchor.length === 0) return 0
  // Search from the end so a repeated anchor (e.g. blank line) picks
  // the last occurrence — that's where the LLM intended to append.
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].textContent.includes(anchor)) return i
  }
  // Anchor text not found anywhere → append at the end of the doc.
  return blocks.length - 1
}

/** Wrap a serialized block DOM node in a `.ProseMirror` host with a
 * tone modifier so the existing tint CSS applies. */
function wrapInToneHost(
  blockDom: Node,
  tone: 'add' | 'remove',
): HTMLElement {
  const host = document.createElement('div')
  host.className = `ProseMirror pending-edit-tone pending-edit-tone--${tone}`
  // Override the live editor's 200px min-height — read-only preview
  // doesn't need a comfortable click area.
  host.style.minHeight = '0'
  host.style.cursor = 'default'
  host.appendChild(blockDom)
  return host
}

/** Wrap a serialized block DOM node in a plain `.ProseMirror` host
 * so the editor's typography rules (font, headings, lists, links)
 * apply without the tone tint. Used for context blocks above and
 * below the change. */
function wrapInPlainHost(blockDom: Node): HTMLElement {
  const host = document.createElement('div')
  host.className = 'ProseMirror'
  host.style.minHeight = '0'
  host.style.cursor = 'default'
  host.appendChild(blockDom)
  return host
}

/** Parse a markdown string and serialize its content to a
 * DocumentFragment. Used for the synthesized "after" block. Returns
 * null when parsing yields no content. */
function renderMarkdownToDom(
  md: string,
  parser: (md: string) => PMNode,
  schema: PMNode['type']['schema'],
): DocumentFragment | null {
  let parsed: PMNode
  try {
    parsed = parser(md)
  } catch (err) {
    console.warn('[proseContext] after-parse failed', err)
    return null
  }
  if (parsed.content.size === 0) return null
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(parsed.content, {
    document,
  }) as DocumentFragment
  return dom
}
