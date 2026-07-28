// Read-it-later save orchestration: URL → a saved note.
//
//   1. extractPage(url)  — defuddle fetch + clean Markdown + metadata
//   2. createArticle(...) — new note in the capture folder (images
//      localize into images/<slug>/ in the background)
//   3. toast
//
// Composes existing primitives only. The saved page is a generic note
// carrying its source metadata; the system timeline indexes it by date,
// so there is no manual daily breadcrumb.

import { extractPage } from '@/profile/adapters/extractPage'
import { createArticle } from '@/state/articleService'
import { captureYoutubeToNote } from '@/state/youtubeService'
import { parseYoutubeId } from '@/lib/youtube'
import { localizeArticleImages } from '@/lib/articleAssets'
import { notify } from '@/lib/notify'
import { useDocsStore } from '@/state/docsStore'

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

  // YouTube URLs capture the transcript (ANDROID InnerTube) instead of
  // scraping the page — a different extractor, same "paste a URL" entry.
  if (parseYoutubeId(trimmed)) {
    try {
      const slug = await captureYoutubeToNote(trimmed)
      if (!slug) {
        notify.articleSaveFailed()
        return { ok: false }
      }
      const title = useDocsStore
        .getState()
        .knownDocs.find((d) => d.slug === slug)?.title
      notify.articleSaved({ title: title ?? 'YouTube video' })
      return { ok: true, slug }
    } catch (err) {
      console.error('[inbox] youtube capture failed', err)
      notify.articleSaveFailed()
      return { ok: false }
    }
  }

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
