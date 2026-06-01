// Read-it-later save orchestration: URL → article doc + daily breadcrumb.
//
//   1. extractPage(url)  — defuddle fetch + clean Markdown + metadata
//   2. createArticle(...) — new `article` doc at articles/<title>.md
//   3. append `- [[Title]]` to today's daily note (bottom)
//   4. toast
//
// Composes existing primitives only. The daily breadcrumb uses the
// canonical `[[Title]]` wikilink form, which resolveWikilinksInMarkdown
// resolves against article docs too (they're non-system, non-archived),
// so the link is clickable and points at the saved article.

import { extractPage } from '@/profile/adapters/extractPage'
import { appendMarkdownToWikiPage } from '@/agent/applyIngest'
import { createArticle } from '@/state/articleService'
import { localizeArticleImages } from '@/lib/articleAssets'
import { generateClientSlug } from '@/lib/slug'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { notify } from '@/lib/notify'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'

export interface SaveArticleResult {
  ok: boolean
  /** Slug of the created article doc, when ok. */
  slug?: string
}

/** Save a URL as a read-it-later article. Non-disruptive: creates the
 * doc, drops a breadcrumb in today's daily, toasts — does NOT navigate.
 * Returns the new slug so a caller could navigate if it wanted to. */
export async function saveArticleFromUrl(url: string): Promise<SaveArticleResult> {
  const trimmed = url.trim()
  if (!trimmed) return { ok: false }

  let docs
  try {
    docs = await extractPage(trimmed)
  } catch (err) {
    console.error('[readlater] extractPage failed', err)
    notify.articleSaveFailed()
    return { ok: false }
  }

  const doc = docs[0]
  if (!doc) {
    notify.articleSaveFailed()
    return { ok: false }
  }

  const slug = await createArticle(
    {
      title: doc.title,
      sourceUrl: doc.sourceUrl,
      siteName: doc.siteName,
      faviconUrl: doc.faviconUrl,
      description: doc.description,
    },
    doc.contentMarkdown,
  )
  if (!slug) {
    notify.articleSaveFailed()
    return { ok: false }
  }

  // Localize images in the background so the save returns instantly.
  // The article first shows with remote image URLs; once downloads
  // finish, the body is rewritten to local copies (offline-ready).
  void localizeImagesInBackground(slug, doc.contentMarkdown, doc.sourceUrl)

  // Breadcrumb in today's daily. Non-fatal: the article is already
  // saved; a failed append shouldn't fail the whole action.
  try {
    const dailySlug = ensureTodayDailySlug()
    await appendMarkdownToWikiPage(dailySlug, `- [[${doc.title}]]`)
  } catch (err) {
    console.warn('[readlater] daily breadcrumb append failed', err)
  }

  notify.articleSaved({ title: doc.title })
  return { ok: true, slug }
}

/** Download the article's images into the vault and swap the body's
 * image links to the local copies. Best-effort and fire-and-forget:
 * runs after the save returns, replaces the body only if something was
 * actually localized. */
async function localizeImagesInBackground(
  slug: string,
  markdown: string,
  sourceUrl?: string,
): Promise<void> {
  try {
    const rewritten = await localizeArticleImages(slug, markdown, sourceUrl)
    if (rewritten !== markdown) {
      await useDocsStore.getState().replaceDocBody(slug, rewritten)
    }
  } catch (err) {
    console.warn('[readlater] image localization failed', err)
  }
}

/** Today's daily slug, creating the catalog entry if missing — WITHOUT
 * opening it as a tab (a read-later save shouldn't steal focus). The
 * append's ensureHandle + flush lands the daily file on disk. Mirrors
 * the creation half of docsStore `openDaily`, minus the activation. */
function ensureTodayDailySlug(): string {
  const today = todayLocalDate()
  const existing = useDocsStore
    .getState()
    .knownDocs.find((d) => d.type === 'daily' && d.date === today)
  if (existing) return existing.slug
  const slug = generateClientSlug()
  const daily: KnownDoc = {
    slug,
    type: 'daily',
    date: today,
    createdAt: new Date().toISOString(),
  }
  useDocsStore.setState((s) => ({ knownDocs: [...s.knownDocs, daily] }))
  return slug
}
