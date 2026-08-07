/**
 * renameWikilinks — when a note is renamed in-app, rewrite every
 * `[[OldTitle]]` across the vault to `[[NewTitle]]`.
 *
 * Links are stored by title (location-independent — see wikilinkResolve),
 * so MOVING a note never breaks links, but RENAMING it silently orphans
 * every inbound `[[OldTitle]]`. Obsidian rewrites them on rename; this does
 * the same. Only fires for IN-APP renames (renameDoc) — an external Finder
 * rename can't be recovered (we never saw the old title), same as Obsidian.
 *
 * The renamed file itself is moved on disk by the flush's rename-on-change
 * machinery; this module only fixes the *references* in other notes.
 */

import { useDocsStore } from '@/state/docsStore'
import { updateDocBody } from '@/state/docsStore/docBody'
import { pathForDoc } from '@/lib/docPaths'
import { readVaultFile, writeVaultFile } from '@/lib/vault'
import { flushDirty } from '@/lib/docFileSync'
import { mergeFrontmatter, splitFrontmatter } from '@/lib/frontmatter'

// Same escape-aware token shape as extractWikilinks (wikilinkResolve), but
// split into open / inner / close groups so a rewrite preserves the exact
// bracket + escape form. Inner is the label, which may carry a `|alias`.
const WIKILINK_RE = /(\\?\[\\?\[)([^\]\n]+?)(\\?\]\\?\])/g

/** Rewrite `[[oldTitle]]` (and `[[oldTitle|alias]]`, preserving the alias)
 * to `[[newTitle]]` wherever the title part matches `oldTitle`
 * case-insensitively (mirrors the resolver's `title.toLowerCase()` match).
 * Non-matching links and partial-name overlaps are left untouched. Pure —
 * unit-tested. */
export function rewriteWikilinkTitle(
  body: string,
  oldTitle: string,
  newTitle: string,
): string {
  const oldLower = oldTitle.trim().toLowerCase()
  return body.replace(WIKILINK_RE, (full, open, inner, close) => {
    const bar = inner.indexOf('|')
    const title = bar === -1 ? inner : inner.slice(0, bar)
    const alias = bar === -1 ? '' : inner.slice(bar) // includes the leading '|'
    if (title.trim().toLowerCase() !== oldLower) return full
    return `${open}${newTitle}${alias}${close}`
  })
}

/** Scan every other note in the vault and rewrite its `[[oldTitle]]`
 * references to `[[newTitle]]`. Fire-and-forget from renameDoc — a failure to
 * rewrite one note just leaves that inbound link stale, not a crash.
 *
 * Two paths, and which one a note takes is decided by whether it has a live
 * handle:
 *
 * **Has a handle** — there is in-memory state newer than disk (the mirror, and
 * possibly a mounted editor holding keystrokes not yet flushed). Go through
 * `updateDocBody`, which reads the LIVE body, serializes per slug, refuses on
 * an unresolved external conflict, and marks the slug dirty so the flush is
 * the only thing that touches disk. Rewriting from disk here is what used to
 * destroy the user's unsaved text: the read missed it, and the follow-up
 * `reloadFromVault` then pushed the disk copy back into the open editor.
 *
 * **No handle** — no mirror and no editor exist for it, so disk IS the note.
 * Read-modify-write it directly, frontmatter preserved verbatim. This branch
 * is not just an optimisation: `updateDocBody` → `ensureHandle` would build a
 * handle for every note in the vault, and building one marks the slug dirty,
 * flags it to the ingest pipeline, and never frees it. */
export async function updateWikilinksForRename(
  renamedSlug: string,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  if (oldTitle.trim().toLowerCase() === newTitle.trim().toLowerCase()) return
  const { knownDocs } = useDocsStore.getState()
  const getDoc = (s: string) => knownDocs.find((d) => d.slug === s)
  const rewrite = (body: string) => rewriteWikilinkTitle(body, oldTitle, newTitle)
  let funnelled = false
  for (const doc of knownDocs) {
    if (doc.slug === renamedSlug) continue
    if (doc.type.startsWith('system:')) continue
    const path = pathForDoc(doc, getDoc)
    if (!path) continue
    try {
      if (useDocsStore.getState().handles[doc.slug]) {
        const r = await updateDocBody(doc.slug, rewrite)
        // `updateDocBody` reports failure rather than throwing, so the catch
        // below never sees these. Without this line a declined rewrite is an
        // undiagnosable stale link.
        if (!r.ok) {
          console.warn('[rename] wikilink rewrite skipped', {
            slug: doc.slug,
            reason: r.reason,
          })
        } else if (r.changed) {
          funnelled = true
        }
        continue
      }

      const raw = await readVaultFile(path)
      const { body } = splitFrontmatter(raw)
      const nextBody = rewrite(body)
      if (nextBody === body) continue // no inbound link here
      // Preserve the note's frontmatter verbatim, swap only the body.
      await writeVaultFile(path, mergeFrontmatter(raw, {}, nextBody))
      // The user can open this note across the two awaits above. A handle born
      // in that window hydrated from the PRE-rewrite disk copy, so the next
      // flush would write it back over us. Re-apply through the funnel — the
      // rewrite is idempotent (the old title is no longer there to match), so
      // it repairs a stale mirror and is a no-op otherwise. A mutex would not
      // help: `ensureHandle` does not take one.
      if (useDocsStore.getState().handles[doc.slug]) {
        await updateDocBody(doc.slug, rewrite)
      }
    } catch (err) {
      console.warn('[rename] wikilink rewrite failed', { path, err })
    }
  }
  // The funnel only marks slugs dirty; without this the rewrites sit in memory
  // for up to one flush interval. `renameDoc` does the same after its own
  // markSlugDirty.
  if (funnelled) void flushDirty()
}
