// Source adapters — given one URL, produce a list of Documents
// (one post = one Document). Three implementations: RSS feeds,
// HTML sitemaps, single-page Readability. The router below tries
// them in order and returns the first non-empty result.
//
// Caller (profile/pipeline.ts) just calls discoverAndFetch and
// feeds the resulting documents into the LLM section prompts.

import { invoke } from '@tauri-apps/api/core'
import { fetchViaRss } from './rss'
import { fetchViaSitemap } from './sitemap'
import { fetchViaReadability } from './readability'

/** A single fetched post. Adapter output and pipeline input.
 * Plain text in contentMarkdown (HTML tags stripped) — the LLM
 * only needs the signal, not perfect markdown rendering. */
export interface Document {
  sourceUrl: string
  title: string
  contentMarkdown: string
  publishedAt?: string
  author?: string
}

/** Raw response from the Tauri fetch_url command. Re-exported here
 * so adapters don't have to know about the invoke shape. */
export interface FetchedPage {
  url: string
  status: number
  contentType: string | null
  body: string
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  return invoke('fetch_url', { url })
}

/** Adapter results capped so the prompt size stays bounded. 8
 * recent posts is enough signal for Voice/Themes/About — going
 * higher just hits the OAuth-token per-minute token limit faster
 * (429 rate_limit_error) without measurably improving the analysis. */
export const MAX_DOCS_PER_RUN = 8

export interface DiscoveryResult {
  adapter: 'rss' | 'sitemap' | 'readability' | 'none'
  documents: Document[]
}

/** Try adapters in order; return the first non-empty result.
 * Order rationale:
 *   - RSS first: cheapest, structured, gives 10-20 posts at once
 *   - Sitemap next: covers blogs without feeds but with sitemap.xml
 *   - Readability last: single-post fallback for when the input is
 *     a leaf article URL, not a blog root */
export async function discoverAndFetch(url: string): Promise<DiscoveryResult> {
  for (const [name, fn] of [
    ['rss', fetchViaRss],
    ['sitemap', fetchViaSitemap],
    ['readability', fetchViaReadability],
  ] as const) {
    try {
      const docs = await fn(url)
      if (docs.length > 0) {
        return { adapter: name, documents: docs.slice(0, MAX_DOCS_PER_RUN) }
      }
    } catch (err) {
      console.warn(`[adapters] ${name} failed`, err)
    }
  }
  return { adapter: 'none', documents: [] }
}
