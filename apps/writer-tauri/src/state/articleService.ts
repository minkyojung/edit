// Article (read-it-later) creation. A saved web page becomes a generic
// inbox `note` at `inbox/<title>.md`, with its source metadata
// (url / site / favicon / savedAt) carried on the KnownDoc and
// persisted through the `.md` frontmatter. Its "saved-page-ness" is the
// `sourceUrl` field, not a doc type. The body is the defuddle-extracted
// Markdown so the editor renders it as a reader.
//
// Mirrors wikiService.ts createCustomWikiPage: mint slug, register the
// catalog entry, seed the body as part of the create transaction. The
// extra markSlugDirty + flushDirty guarantees the sidecar (and thus the
// metadata) lands on disk immediately, even if the body is empty.

import { generateClientSlug } from '@/lib/slug'
import { flushDirty, markSlugDirty } from '@/lib/docFileSync'
import { sanitizeFilename } from '@/lib/docPaths'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'

export interface ArticleInput {
  title: string
  sourceUrl?: string
  siteName?: string
  faviconUrl?: string
  description?: string
  /** ISO timestamp the article was saved. Defaults to now. */
  savedAt?: string
}

/** Create a read-it-later article doc and return its slug (or null on
 * failure). The doc is registered in the catalog but NOT auto-opened —
 * the caller decides whether to navigate (read-later saves stay put). */
export async function createArticle(
  input: ArticleInput,
  bodyMarkdown: string,
): Promise<string | null> {
  const title = input.title.trim()
  if (!title) return null

  const slug = generateClientSlug()
  const now = new Date().toISOString()
  const doc: KnownDoc = {
    slug,
    type: 'note',
    title,
    relPath: `inbox/${sanitizeFilename(title)}.md`,
    createdAt: now,
    savedAt: input.savedAt ?? now,
    sourceUrl: input.sourceUrl,
    siteName: input.siteName,
    faviconUrl: input.faviconUrl,
    description: input.description,
  }
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, doc] }))

  // Seed the body as part of the create transaction so the page is
  // fully ready on return.
  if (bodyMarkdown.trim()) {
    try {
      await useDocsStore.getState().seedDocBody(slug, bodyMarkdown)
    } catch (err) {
      console.warn('[article] createArticle seed failed', err)
    }
  }

  // Force the sidecar to disk now so the metadata survives a restart
  // even before any later edit (seedDocBody marks the body dirty, but
  // an empty body would skip that — be explicit).
  markSlugDirty(slug)
  void flushDirty()

  return slug
}
