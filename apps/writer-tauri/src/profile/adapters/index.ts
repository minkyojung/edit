// Shared shapes for the page-extraction path, plus the one Tauri fetch it
// needs. `extractPage.ts` is the sole consumer; it lives next door and imports
// `Document` / `FetchedPage` / `fetchPage` from here.
//
// This file used to be a router: given a URL it tried RSS, then an HTML
// sitemap, then single-page extraction, and handed the resulting Documents to
// the profile pipeline. That pipeline and the two multi-post adapters are gone
// (nothing called them), so only the single-page shapes remain.

import { invoke } from '@tauri-apps/api/core'

/** A single fetched post. Adapter output and pipeline input.
 * contentMarkdown is structure-preserving Markdown (headings, lists,
 * links survive) produced by defuddle. */
export interface Document {
  sourceUrl: string
  title: string
  contentMarkdown: string
  publishedAt?: string
  author?: string
  // Source metadata for display surfaces (e.g. a read-it-later card in
  // the daily note) and for length-based heuristics. Populated by the
  // single-page path (extractPage); absent on the RSS path.
  siteName?: string
  faviconUrl?: string
  description?: string
  wordCount?: number
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
