// Direct in-place edit of a doc's body. The chat-side equivalent of
// Phase 2.A's `appendMarkdownToWikiPage`, used by the new
// `edit_document` tool: the LLM emits a `quote` from the doc plus a
// `content` to put in its place, and we swap the substring.
//
// Two paths mirror the wiki-append helper:
//
//   - Active doc — serialize the live PM doc to markdown, do a
//     string replace, push the result back through the atomic
//     `replaceMarkdownInYDoc`. The replace lands in Y.Doc, the
//     vault flush picks it up on the next 2 s tick.
//
//   - Inactive doc — read `.md` from disk, string replace, write
//     back, then `ensureHandle + reloadFromVault` so any in-memory
//     Y.Doc handle (warmed at boot or by a previous chat) mirrors
//     the new body. Same lesson as Phase 2.A: stale `.ydoc` cache
//     would otherwise resurrect the pre-edit state on next mount.
//
// Quote matching is plain substring `indexOf`. The LLM is prompted
// to echo the quote verbatim from the doc context the system prompt
// already includes, so an exact match is the common case. When the
// match fails (whitespace drift, off-by-one) we return `quote_not_found`
// and the caller surfaces that to the user — no partial / fuzzy
// replace, because guessing would be more annoying than honest
// failure.

import { useEditorViewStore } from '@/state/editorViewStore'
import { useDocsStore } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { pathForDoc } from '@/lib/docPaths'
import { readVaultFile, writeVaultFile, vaultFileExists } from '@/lib/vault'
import { replaceMarkdownInYDoc } from '@/lib/seedMarkdown'

export interface DirectEdit {
  /** Verbatim slice of the doc the edit targets. Empty string means
   * "insert at the top" — caller can use that for prepending. */
  quote: string
  /** Text to substitute in place of `quote`. Empty string means
   * "delete `quote`". */
  content: string
  /** Optional reason the model gave. Surfaces in commit-message
   * bodies and the Review panel. */
  rationale?: string
}

export type EditOutcome =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'no_doc'
        | 'no_parser'
        | 'quote_not_found'
        | 'no_md_path'
        | 'io_error'
    }

/** Apply one edit to `slug`'s body. Does NOT commit — callers
 * batch multiple edits per turn into a single commit at the chat
 * engine layer. */
export async function applyDirectEdit(
  slug: string,
  edit: DirectEdit,
): Promise<EditOutcome> {
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug && !d.archivedAt)
  if (!known) return { ok: false, reason: 'no_doc' }
  const parser = useEditorViewStore.getState().parser
  if (!parser) return { ok: false, reason: 'no_parser' }

  // Active path: serialize the PM doc to markdown, splice, and
  // push back. We go through markdown (rather than computing PM
  // positions from `quote`) because the doc's serialized form is
  // the contract every other writer in the codebase (Phase 2.A
  // appends, ingest flushes, profile pipeline replace) already
  // shares; reaching into PM positions would multiply the off-by-
  // one risks without buying anything for a one-shot string swap.
  const view = useEditorViewStore.getState().view
  const activeSlug = getActiveSlugFromHash()
  const serializer = useEditorViewStore.getState().serializer
  if (view && serializer && activeSlug === slug) {
    let md: string
    try {
      md = serializer(view.state.doc)
    } catch (err) {
      console.warn('[applyDirectEdit] active serialize failed', slug, err)
      return { ok: false, reason: 'io_error' }
    }
    const newMd = spliceQuote(md, edit.quote, edit.content)
    if (newMd === null) return { ok: false, reason: 'quote_not_found' }
    // replaceMarkdownInYDoc is the atomic helper we hardened during
    // Phase 2.A's mount-race fix — clear + reseed land inside one
    // Y.Doc transaction so the editor never sees an empty fragment.
    const handle = docs.handles[slug]
    if (!handle) return { ok: false, reason: 'no_doc' }
    replaceMarkdownInYDoc(handle.ydoc, newMd, parser)
    return { ok: true }
  }

  // Inactive path: disk read + write + Y.Doc resync. Same shape as
  // appendMarkdownToWikiPage so the two helpers fail and succeed
  // in the same ways.
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath) return { ok: false, reason: 'no_md_path' }
  let existingMd = ''
  if (await vaultFileExists(mdPath)) {
    try {
      existingMd = await readVaultFile(mdPath)
    } catch (err) {
      console.warn('[applyDirectEdit] read failed', mdPath, err)
      return { ok: false, reason: 'io_error' }
    }
  }
  const newMd = spliceQuote(existingMd, edit.quote, edit.content)
  if (newMd === null) return { ok: false, reason: 'quote_not_found' }
  try {
    await writeVaultFile(mdPath, newMd)
  } catch (err) {
    console.error('[applyDirectEdit] write failed', mdPath, err)
    return { ok: false, reason: 'io_error' }
  }
  try {
    await docs.ensureHandle(slug)
    await docs.reloadFromVault(slug)
  } catch (err) {
    console.warn('[applyDirectEdit] Y.Doc resync failed', slug, err)
    // Disk truth is correct; next ensureHandle picks it up.
  }
  return { ok: true }
}

/** Replace the first occurrence of `quote` in `text` with `content`.
 * Returns null when `quote` isn't found verbatim — caller surfaces
 * the miss; we don't try to recover by partial / fuzzy matching.
 *
 * Empty `quote` is a special signal: "prepend content at the top of
 * the doc". This lets the same tool express insert without a
 * separate kind, mirroring Karpathy's preference for one minimal
 * surface over multiple variants.
 *
 * Exported for testing. */
export function spliceQuote(
  text: string,
  quote: string,
  content: string,
): string | null {
  if (quote.length === 0) {
    // Insert at the top. Add a separating newline when the doc
    // isn't empty so the new block doesn't run into the next one.
    if (text.length === 0) return content
    return `${content}\n\n${text.trimStart()}`
  }
  const idx = text.indexOf(quote)
  if (idx === -1) return null
  return text.slice(0, idx) + content + text.slice(idx + quote.length)
}
