// Persist a freshly-extracted Profile to the wiki:profile page.
//
// The page may not exist yet (first-run bootstrap) — ensureProfileWikiSlug
// creates it on demand using the same lazy-create helper that backs
// system:conventions / system:log / system:index. Once the slug is
// in hand, seedDocBody plants the markdown atomically (Y.Doc +
// vault write + dirty flush).
//
// The function intentionally does NOT call setActive — the caller
// (BootstrapDialog Stage 2) decides whether to navigate. That keeps
// the helper composable for future paths (e.g. ingest auto-update
// updating the profile silently without yanking the user away from
// their current doc).

import { useDocsStore } from '@/state/docsStore'
import { ensureProfileWikiSlug } from '@/state/wikiService'

/** Save the profile markdown body to wiki:profile. Returns the
 * doc slug on success, null when either page creation or body
 * seeding failed. Caller surfaces failure to the user. */
export async function saveProfileToVault(
  profileMarkdown: string,
): Promise<string | null> {
  const slug = await ensureProfileWikiSlug()
  if (!slug) return null
  try {
    await useDocsStore.getState().seedDocBody(slug, profileMarkdown)
    return slug
  } catch (err) {
    console.error('[profile:save] seedDocBody failed', { slug, err })
    return null
  }
}
