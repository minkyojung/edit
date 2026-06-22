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

import { useEditorViewStore } from '@/state/editorViewStore'
import { applyMarkdownToActiveCmEditor } from '@/state/activeCmEditor'
import { useDocsStore } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { markSlugDirty } from '@/lib/docFileSync'
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
 * Flow:
 *   1. ensureHandle — synthesise the in-memory handle if the doc
 *      has never been opened; the handle's `bodyMarkdown` is the
 *      source of truth for the current content.
 *   2. transform(oldMd) → newMd. No-op when identical.
 *   3. Update `handle.bodyMarkdown` immediately. Phase I made this
 *      the live in-memory mirror, so the next flush picks it up.
 *   4. If the doc is the active editor, also dispatch a full
 *      `replaceWith(0, doc.size, parser(newMd))` so the user sees
 *      the change instantly. The PM dispatch fires
 *      `dirtyTrackerPlugin` which marks the slug dirty and re-syncs
 *      `bodyMarkdown` from PM (roundtrip should be identity).
 *   5. If NOT active, mark the slug dirty manually — no plugin
 *      observes bodyMarkdown mutations directly.
 *
 * The 500-ms flush tick (Phase I) writes the actual `.md` file.
 * Returns false on hard failures only (unknown slug, ensureHandle
 * failure, parser missing for an active doc); a no-op transform
 * still returns true. */
export async function applyToWikiPage(
  slug: string,
  transform: (currentMd: string) => string,
  changeId?: string,
): Promise<boolean> {
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug && !d.archivedAt)
  if (!known) {
    console.warn('[apply] unknown slug', slug)
    return false
  }

  try {
    await docs.ensureHandle(slug)
  } catch (err) {
    console.warn('[apply] ensureHandle failed', slug, err)
    return false
  }
  const handle = useDocsStore.getState().handles[slug]
  if (!handle) return false

  const oldMd = handle.bodyMarkdown
  const newMd = transform(oldMd)
  if (newMd === oldMd) return true

  // Live in-memory mirror first. flushDirty (Phase I) writes from
  // this on the next tick.
  handle.bodyMarkdown = newMd

  // CodeMirror editor (no PM view): push the new body straight into the live CM doc
  // via the same bridge external-reload uses, then mark dirty (the CM body-set is
  // annotated to skip its own dirty-tracking). Without this, an accepted edit reached
  // disk but the open CM editor didn't update until reload.
  if (applyMarkdownToActiveCmEditor(slug, newMd, changeId)) {
    markSlugDirty(slug)
    return true
  }

  const view = useEditorViewStore.getState().view
  const activeSlug = getActiveSlugFromHash()
  const isActive = !!view && activeSlug === slug

  if (isActive) {
    const parser = useEditorViewStore.getState().parser
    if (!parser) {
      console.warn('[apply] active doc but parser unavailable', slug)
      // bodyMarkdown is updated; the dispatch fallback is just for
      // visual immediacy. Mark dirty so flushDirty still writes.
      markSlugDirty(slug)
      return true
    }
    const parsed = parser(newMd)
    if (!parsed) {
      console.warn('[apply] parse failed for', slug)
      markSlugDirty(slug)
      return true
    }
    const tr = view.state.tr.replaceWith(
      0,
      view.state.doc.content.size,
      parsed.content,
    )
    // `addToHistory: false` so the user's Cmd+Z stack doesn't pick
    // up this AI-driven swap. Reversing an Accept lives on the
    // inline Reject button, not the undo stack — undoing here would
    // wipe the new body without re-surfacing the widget.
    view.dispatch(tr.setMeta('addToHistory', false))
    // dirtyTrackerPlugin (Phase I) marks dirty + re-syncs
    // bodyMarkdown from the PM doc as a side-effect of the dispatch
    // above. No explicit markSlugDirty needed.
  } else {
    // No PM editor for this slug — manually mark dirty since the
    // dirtyTrackerPlugin only sees the active doc's transactions.
    markSlugDirty(slug)
  }

  return true
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


