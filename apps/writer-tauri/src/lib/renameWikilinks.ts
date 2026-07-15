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
import { pathForDoc } from '@/lib/docPaths'
import { readVaultFile, writeVaultFile } from '@/lib/vault'
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
 * references to `[[newTitle]]`. Reads/writes each note's body on disk
 * (frontmatter preserved verbatim via mergeFrontmatter); for any note that's
 * currently open, re-hydrates its handle + live editor from the rewritten
 * file via reloadFromVault. Fire-and-forget from renameDoc — a failure to
 * rewrite one note just leaves that inbound link stale, not a crash. */
export async function updateWikilinksForRename(
  renamedSlug: string,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  if (oldTitle.trim().toLowerCase() === newTitle.trim().toLowerCase()) return
  const { knownDocs } = useDocsStore.getState()
  const getDoc = (s: string) => knownDocs.find((d) => d.slug === s)
  for (const doc of knownDocs) {
    if (doc.slug === renamedSlug) continue
    if (doc.type.startsWith('system:')) continue
    const path = pathForDoc(doc, getDoc)
    if (!path) continue
    try {
      const raw = await readVaultFile(path)
      const { body } = splitFrontmatter(raw)
      const nextBody = rewriteWikilinkTitle(body, oldTitle, newTitle)
      if (nextBody === body) continue // no inbound link here
      // Preserve the note's frontmatter verbatim, swap only the body.
      await writeVaultFile(path, mergeFrontmatter(raw, {}, nextBody))
      // If the note is open, sync its handle + (active) editor from disk —
      // same path an external edit takes.
      if (useDocsStore.getState().handles[doc.slug]) {
        await useDocsStore.getState().reloadFromVault(doc.slug)
      }
    } catch (err) {
      console.warn('[rename] wikilink rewrite failed', { path, err })
    }
  }
}
