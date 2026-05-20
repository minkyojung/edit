// Single-page Readability adapter. Used when the input URL is a leaf
// article (no feed, no sitemap) — extract the main content and
// return it as one Document.
//
// Mozilla Readability mutates the DOM it runs against, so we parse
// into a fresh document each call. Falls back to the document's
// own <title> if Readability returns no title.

import { Readability } from '@mozilla/readability'
import type { Document } from './index'
import { fetchPage } from './index'

export async function fetchViaReadability(url: string): Promise<Document[]> {
  const page = await fetchPage(url)
  if (page.status >= 400) return []

  const dom = new DOMParser().parseFromString(page.body, 'text/html')
  // Readability needs a baseURI to resolve relative links inside the
  // article. The cleanest way is to inject a <base> tag.
  if (!dom.head.querySelector('base')) {
    const base = dom.createElement('base')
    base.setAttribute('href', page.url)
    dom.head.prepend(base)
  }

  // Readability's typed signature isn't generic over the DOM impl;
  // the runtime accepts the browser's Document just fine.
  const article = new Readability(dom).parse()
  if (!article || !article.textContent) return []

  const fallbackTitle = dom.querySelector('title')?.textContent?.trim() ?? '(untitled)'
  return [
    {
      sourceUrl: page.url,
      title: (article.title || fallbackTitle).trim(),
      contentMarkdown: article.textContent.replace(/\s+/g, ' ').trim(),
      author: article.byline?.trim() || undefined,
    },
  ]
}
