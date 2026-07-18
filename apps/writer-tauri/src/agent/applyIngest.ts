// Apply layer for ingest — the "COMPILE" step in Karpathy's
// LLM-wiki pipeline. Takes proposals the model emitted and lands them
// directly into the target wiki pages (Phase 2.A flip — review queue
// removed). Two surfaces:
//
//   - appendMarkdownToWikiPage(slug, md)
//       Append `md` to the end of a wiki page. Active doc takes the
//       PM-transaction path so the user sees the insertion live;
//       inactive doc routes through the on-disk `.md` + a Y.Doc
//       reload so any future open of the page shows fresh content.

import { useDocsStore } from '@/state/docsStore'
import { updateDocBody } from '@/state/docsStore/docBody'
import { looseReplace } from '@/lib/looseMatch'
import { splitFrontmatter } from '@/lib/frontmatter'
import { appendToBackground } from '@/profile/markers'


/** Single canonical "apply a markdown transformation to wiki page
 * `slug`" entry point. Phase J: replaces the per-function active /
 * inactive split with one path that operates on the markdown layer.
 *
 * Why this shape (vs the prior PM-fragment-insert for active):
 *   The previous active path parsed the new markdown into a fragment
 *   and `tr.insert`-ed it at end of doc. When the existing doc
 *   already ended in a `bullet_list` and the new fragment also
 *   started with one, ProseMirror's list-joining heuristics
 *   sometimes nested the new bullets under an empty parent item.
 *   The inactive path, which appends at the markdown level and
 *   re-parses the whole doc, never had that quirk because the
 *   parser sees fully-separated `\n\n`-delimited blocks. Phase J
 *   collapses both paths onto the markdown-level approach so the
 *   active and inactive outputs match by construction.
 *
 * Flow: guard that `slug` is a known doc, then hand the read-modify-write
 * to `updateDocBody` (the single body-write funnel), which serializes per
 * slug, awaits hydration, reads the live editor body when one is mounted,
 * assigns the mirror, pushes into the live editor, and marks the slug dirty
 * for the 500-ms flush that writes the actual `.md`.
 *
 * Returns false on hard failures (unknown slug, no handle, hydration
 * failure) or when the write is refused because the doc has an unresolved
 * external conflict; a landed write or a no-op transform returns true. */
export async function applyToWikiPage(
  slug: string,
  transform: (currentMd: string) => string,
  changeId?: string,
): Promise<boolean> {
  const known = useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
  if (!known) {
    console.warn('[apply] unknown slug', slug)
    return false
  }
  // Delegate the read-modify-write to the single body-write funnel, which owns
  // per-slug serialization (concurrent auto-accepts to one note can't clobber
  // each other → no dropped edit that desyncs the model's assumed content),
  // the hydration wait, reading the LIVE editor body (so an accept can't drop
  // keystrokes typed since the last flush — the old impl read the stale mirror
  // here), the editor push, and the dirty-mark.
  const result = await updateDocBody(slug, transform, { changeId })
  // Boolean contract preserved: a landed write or a no-op transform → true;
  // hard failures (no handle / hydration) → false. A write refused because the
  // doc has an unresolved external conflict also returns false — correctly
  // "not applied", surfaced to the model rather than silently dropped.
  return result.ok
}

/** Append `markdown` to the end of wiki page `slug`. The LLM emits
 * `[[Title]]` wiki references per the CLAUDE.md convention and we
 * write them VERBATIM — no `[X](note:slug)` resolution at the I/O
 * boundary. Phase K2: keeping disk and memory byte-equivalent so
 * subsequent replace passes can match what the LLM saw on disk.
 *
 * Trade-off: until the wikilink plugin gains a parse-time rewrite
 * (planned), `[[Title]]` tokens render as literal text in the
 * editor for content the user did not author through the palette.
 * The user-typed palette path continues to emit
 * `[Title](note:slug)` directly into PM, which renders as a real
 * link — the existing renderer covers it. */
export async function appendMarkdownToWikiPage(
  slug: string,
  markdown: string,
  changeId?: string,
): Promise<boolean> {
  const trimmed = markdown.trim()
  if (trimmed.length === 0) return false
  // The self-profile (`wiki:profile`) is zoned: derivation sections at
  // the top, then `## Background` (the append target), then the user's
  // `## Notes`. Facts about the user must land in Background — a raw
  // end-of-file append would drop them after `## Notes` (the user's
  // area) and outside any labelled zone. Every other page is a flat
  // list of facts, so the plain end-append is correct there.
  const isProfile =
    useDocsStore.getState().knownDocs.find((d) => d.slug === slug)?.type ===
    'wiki:profile'
  return applyToWikiPage(
    slug,
    (oldMd) => {
      if (isProfile) return appendToBackground(oldMd, trimmed)
      const head = oldMd.trimEnd()
      const sep = head.length > 0 ? '\n\n' : ''
      return `${head}${sep}${trimmed}\n`
    },
    changeId,
  )
}

/** Replace `before` text with `after` in wiki page `slug`. Match is
 * literal against the in-memory markdown — the LLM grabs old_string
 * from the on-disk shape and `handle.bodyMarkdown` is the post-
 * Phase-I mirror of that shape, so the comparison is direct (no
 * PM-side markdown-prefix-strip fallback required). Returns false
 * when `before` isn't present — caller treats that as "decision
 * recorded but stale". */
export async function applyReplaceInWikiPage(
  slug: string,
  before: string,
  after: string,
  changeId?: string,
): Promise<boolean> {
  if (before.length === 0) return false
  let foundMatch = false
  const ok = await applyToWikiPage(
    slug,
    (oldMd) => {
      // Tolerant match (exact → normalized-line) so a benign drift in the
      // model's `old_string` (leading bullet, colon spacing, trailing
      // space) still resolves instead of failing the edit — the failure
      // mode that made `propose_edit` get disabled in the first place.
      const replaced = looseReplace(oldMd, before, after)
      if (replaced !== null) {
        foundMatch = true
        return replaced
      }
      // Frontmatter fallback. The model reads the WHOLE file (frontmatter +
      // body) via Read, but `oldMd` here is body-only — the handle strips
      // frontmatter (handlesSlice). So a `before` that quotes the file's
      // frontmatter (commonly the model wrapping new content as
      // `---…--- + body`) never matches. Strip the frontmatter off both
      // sides and retry against the body; if nothing's left to match, the
      // net intent is "add this body", so append it.
      const beforeBody = splitFrontmatter(before).body
      if (beforeBody !== before) {
        const afterBody = splitFrontmatter(after).body
        if (beforeBody.trim().length === 0) {
          const head = oldMd.trimEnd()
          const sep = head.length > 0 ? '\n\n' : ''
          foundMatch = true
          return `${head}${sep}${afterBody.trim()}\n`
        }
        const r2 = looseReplace(oldMd, beforeBody, afterBody)
        if (r2 !== null) {
          foundMatch = true
          return r2
        }
      }
      return oldMd
    },
    changeId,
  )
  if (!ok) return false
  if (!foundMatch) {
    // Diagnostic: log the byte-level shape so we can see whether the
    // mismatch is a wikilink-form drift, whitespace, or something
    // else. Trimmed to keep the console readable.
    const handle = useDocsStore.getState().handles[slug]
    const bodySnippet = handle?.bodyMarkdown?.slice(0, 600) ?? '(no handle)'
    console.warn('[applyReplace] before-text not found in body', {
      slug,
      before: JSON.stringify(before),
      bodySnippet: JSON.stringify(bodySnippet),
    })
    return false
  }
  return true
}

/** Overwrite wiki page `slug` with `content` (the chat Write tool
 * shape). Resolves wikilinks and replaces the body wholesale. */
export async function applyWriteWikiPage(
  slug: string,
  content: string,
  changeId?: string,
): Promise<boolean> {
  return applyToWikiPage(slug, () => content, changeId)
}


