// Sitemap adapter. Tries the conventional /sitemap.xml on the input
// URL's host, parses URLs out of it, then runs each through
// Readability to get content. Used when RSS isn't available but the
// site still publishes a sitemap (common for static-site generators).
//
// We deliberately don't crawl sitemap indexes (sitemaps that point
// to other sitemaps) recursively — one level is enough for blog-
// sized sites, and recursion would invite a wide IO fanout we don't
// need for onboarding.

import type { Document } from './index'
import { fetchPage, MAX_DOCS_PER_RUN } from './index'
import { fetchViaReadability } from './readability'

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'

export async function fetchViaSitemap(inputUrl: string): Promise<Document[]> {
  const sitemapUrl = guessSitemapUrl(inputUrl)
  if (!sitemapUrl) return []

  const page = await fetchPage(sitemapUrl)
  if (page.status >= 400) return []

  const urls = parseSitemapUrls(page.body)
  if (urls.length === 0) return []

  // Cap before fetching so we don't fire 200 GETs for a big sitemap.
  // Each URL goes through Readability sequentially-ish (in batches)
  // so the LLM-bound network doesn't get hammered.
  const limited = urls.slice(0, MAX_DOCS_PER_RUN)
  const docs: Document[] = []
  for (const url of limited) {
    try {
      const result = await fetchViaReadability(url)
      if (result[0]) docs.push(result[0])
    } catch (err) {
      console.warn('[adapters] sitemap entry failed', url, err)
    }
  }
  return docs
}

function guessSitemapUrl(inputUrl: string): string | null {
  try {
    const u = new URL(inputUrl)
    return `${u.protocol}//${u.host}/sitemap.xml`
  } catch {
    return null
  }
}

function parseSitemapUrls(body: string): string[] {
  const xml = new DOMParser().parseFromString(body, 'application/xml')
  if (xml.querySelector('parsererror')) return []

  // urlset/url/loc — the standard schema. Namespaced lookup so we
  // don't accidentally match arbitrary <loc> elements.
  const locs = Array.from(xml.getElementsByTagNameNS(SITEMAP_NS, 'loc'))
  return locs
    .map((el) => el.textContent?.trim() ?? '')
    .filter((u) => u.length > 0)
}
