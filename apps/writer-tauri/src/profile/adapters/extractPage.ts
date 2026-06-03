// Single-page extraction. Given a leaf article URL, fetch it and
// return its main content as one Document — clutter (nav, ads,
// footers) removed, structure (headings, lists, links) preserved as
// Markdown.
//
// This is the one extraction path shared by the single-page input
// case and the sitemap adapter. Defuddle replaces the older
// Readability adapter: Readability returned whitespace-collapsed
// plain text (headings/lists/links/paragraph breaks all gone),
// whereas Defuddle emits structured Markdown and fills richer
// metadata (published date, author).
//
// Defuddle's Markdown conversion (the `/full` build) runs HTML →
// turndown, which needs a global `document`. That exists in the
// Tauri webview but not in Node — so this path is only exercisable
// in-app, not from a headless script.

import Defuddle from 'defuddle/full'
import type { Document } from './index'
import { fetchPage } from './index'
import { resolveUrl } from './html'

/** Normalize a favicon reference into an absolute https URL.
 * Defuddle returns these in mixed forms — relative (`/icon.png`) or
 * insecure absolute (`http://host/favicon.ico`) — so resolve against
 * the page URL and upgrade http → https (favicons are served over
 * https effectively everywhere, and the webview blocks mixed content). */
function normalizeFavicon(favicon: string | undefined, base: string): string | undefined {
  const trimmed = favicon?.trim()
  if (!trimmed) return undefined
  return resolveUrl(trimmed, base).replace(/^http:\/\//, 'https://')
}

export async function extractPage(url: string): Promise<Document[]> {
  const page = await fetchPage(url)
  if (page.status >= 400) return []

  const dom = new DOMParser().parseFromString(page.body, 'text/html')

  // `url` lets Defuddle resolve relative links inside the article;
  // `markdown` selects Markdown output over the default HTML.
  const result = new Defuddle(dom, { url: page.url, markdown: true }).parse()
  const content = result.content?.trim()
  if (!content) return []

  const fallbackTitle = dom.querySelector('title')?.textContent?.trim() ?? '(untitled)'
  return [
    {
      sourceUrl: page.url,
      title: (result.title || fallbackTitle).trim(),
      contentMarkdown: content,
      publishedAt: result.published?.trim() || undefined,
      author: result.author?.trim() || undefined,
      // Source metadata for display / heuristics. site falls back to
      // domain; favicon is normalized; all left undefined when empty.
      siteName: result.site?.trim() || result.domain?.trim() || undefined,
      faviconUrl: normalizeFavicon(result.favicon, page.url),
      description: result.description?.trim() || undefined,
      wordCount: typeof result.wordCount === 'number' && result.wordCount > 0
        ? result.wordCount
        : undefined,
    },
  ]
}
