// URL → markdown for the Profile bootstrap pipeline.
//
// Routes the input URL through one of three extraction paths,
// chosen by host pattern:
//
//   - RSS/Atom feed (Substack, Medium, Ghost, WordPress, anything
//     advertising a feed URL) → batched extraction of recent posts.
//     One paste gets the user a corpus, not a single sample.
//   - Article (everything else) → Readability via the @extractus
//     library. Strips nav/footers/ads to give the LLM the prose.
//   - oEmbed for x.com / twitter.com — v0 stub. We return the raw
//     status URL so the LLM can at least cite the source; full
//     timeline import is deferred to a ZIP path later.
//
// All routes converge on the same return shape so the caller
// (`extractProfile`) treats every source as "one markdown blob
// with metadata." The Rust side (`fetch_url` Tauri command)
// owns the network call; this file is pure orchestration +
// HTML parsing.

import { invoke } from '@tauri-apps/api/core'
import { extractFromHtml } from '@extractus/article-extractor'
import Parser from 'rss-parser'

export type SourceType = 'rss' | 'article' | 'oembed' | 'unsupported'

export interface FetchedSource {
  /** Final resolved URL after redirects. */
  url: string
  /** Human display label — feed title or page title. */
  title: string | null
  /** Author / byline if discoverable. Profile extraction uses this
   * as a corroborating signal for the user's name. */
  byline: string | null
  /** Markdown body. For RSS this is concatenated post bodies (or
   * descriptions); for Article it's the Readability-extracted prose. */
  markdown: string
  /** Which path produced this — surfaces in the Profile Review UI
   * so the user knows which URLs gave rich data vs single tweets. */
  sourceType: SourceType
  /** How many sub-items the source yielded (RSS post count, 1 for
   * article/oembed). Drives the "fetched 8 posts" status line. */
  itemCount: number
}

interface FetchedPageRaw {
  url: string
  status: number
  content_type: string | null
  body: string
}

const MAX_RSS_ITEMS = 10
const RSS_HOSTS = /(^|\.)(substack\.com|medium\.com)$/i

/** Top-level orchestrator. Returns null when we can't extract
 * anything useful (unsupported host, fetch failure, empty body) —
 * caller decides whether to surface to the user or just skip. */
export async function fetchUrlAsMarkdown(rawUrl: string): Promise<FetchedSource | null> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    console.warn('[profile:fetch] invalid URL', { rawUrl })
    return null
  }
  const host = parsed.host.toLowerCase()

  // Twitter / X — v0 stub. Full timeline is gated behind X's paid
  // API; we surface the URL as a single-tweet placeholder so the
  // LLM has something to anchor to.
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    return {
      url: parsed.toString(),
      title: null,
      byline: null,
      markdown: `[Twitter URL]\n${parsed.toString()}\n\n(Twitter/X content is not yet fetched. Paste the relevant tweet text manually or upload a Twitter data export ZIP.)`,
      sourceType: 'oembed',
      itemCount: 1,
    }
  }

  // RSS / Atom — try known hosts directly, plus a probe attempt for
  // anything that exposes a feed URL via <link rel="alternate" ...>.
  if (RSS_HOSTS.test(host)) {
    const feedUrl = inferFeedUrl(parsed)
    if (feedUrl) {
      const rss = await tryFetchAsRss(feedUrl)
      if (rss) return rss
    }
  }

  // Generic article path. Fetch the HTML, run Readability, fall back
  // to a feed link discovered in the page <head> if Readability fails.
  const page = await fetchPage(parsed.toString())
  if (!page) return null

  // First — see if the page is itself a feed (some users paste the
  // /feed URL directly). RSS parsers handle XML directly.
  if (looksLikeFeed(page)) {
    const rss = await parseRssBody(page.url, page.body)
    if (rss) return rss
  }

  // Otherwise treat as an article. Look for an embedded feed link as
  // a fallback path before falling through to Readability — many blog
  // home pages have thin Readability output but rich RSS.
  const embeddedFeed = discoverFeedUrl(page.body, page.url)
  if (embeddedFeed && embeddedFeed !== page.url) {
    const rss = await tryFetchAsRss(embeddedFeed)
    if (rss) return rss
  }

  return await extractArticle(page)
}

// ── RSS path ───────────────────────────────────────────────────────

function inferFeedUrl(parsed: URL): string | null {
  const host = parsed.host.toLowerCase()
  if (host.endsWith('substack.com')) {
    // Substack publication: keep host, replace path with /feed.
    return `${parsed.protocol}//${parsed.host}/feed`
  }
  if (host === 'medium.com' || host.endsWith('.medium.com')) {
    // Medium: /feed/@user or /feed/<publication>. If the URL has a
    // path segment that looks like a user/publication, splice /feed
    // in front of it.
    const segs = parsed.pathname.split('/').filter(Boolean)
    if (segs.length === 0) return null
    const handle = segs[0]
    return `https://medium.com/feed/${handle}`
  }
  return null
}

async function tryFetchAsRss(feedUrl: string): Promise<FetchedSource | null> {
  const page = await fetchPage(feedUrl)
  if (!page) return null
  return parseRssBody(page.url, page.body)
}

async function parseRssBody(
  finalUrl: string,
  body: string,
): Promise<FetchedSource | null> {
  try {
    const parser = new Parser({ timeout: 8000 })
    const feed = await parser.parseString(body)
    const items = (feed.items ?? []).slice(0, MAX_RSS_ITEMS)
    if (items.length === 0) return null
    const sections = items.map((it) => {
      const heading = it.title ? `## ${it.title}` : '##'
      const meta = it.pubDate ? `*${it.pubDate}*` : ''
      const body = stripHtml(it['content:encoded'] ?? it.content ?? it.contentSnippet ?? it.summary ?? '')
      return [heading, meta, body].filter((s) => s.trim().length > 0).join('\n\n')
    })
    const byline = items.find((it) => it.creator || it.author)
    return {
      url: finalUrl,
      title: feed.title ?? null,
      byline: byline?.creator ?? byline?.author ?? null,
      markdown: sections.join('\n\n---\n\n'),
      sourceType: 'rss',
      itemCount: items.length,
    }
  } catch (err) {
    console.warn('[profile:fetch] RSS parse failed', { finalUrl, err })
    return null
  }
}

function looksLikeFeed(page: FetchedPageRaw): boolean {
  const ct = (page.content_type ?? '').toLowerCase()
  if (
    ct.includes('rss') ||
    ct.includes('atom') ||
    ct.includes('xml')
  ) {
    return true
  }
  // Content-type unreliable on some hosts — sniff the body for the
  // canonical RSS/Atom root tag.
  const head = page.body.slice(0, 512).toLowerCase()
  return head.includes('<rss') || head.includes('<feed')
}

/** Find a feed URL advertised in the page <head> via
 * `<link rel="alternate" type="application/rss+xml" href="..." />`.
 * Returns absolute URL or null. */
function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const re = /<link\b[^>]*rel=["']alternate["'][^>]*>/gi
  for (const match of html.match(re) ?? []) {
    const typeMatch = match.match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    if (!typeMatch) continue
    if (!typeMatch.includes('rss') && !typeMatch.includes('atom')) continue
    const href = match.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    try {
      return new URL(href, baseUrl).toString()
    } catch {
      continue
    }
  }
  return null
}

// ── Article path ───────────────────────────────────────────────────

async function extractArticle(page: FetchedPageRaw): Promise<FetchedSource | null> {
  try {
    const article = await extractFromHtml(page.body, page.url)
    if (!article || !article.content) {
      // Last-resort: strip all HTML and return whatever text the page
      // had. Better than nothing for thin home pages.
      const fallback = stripHtml(page.body)
      if (fallback.trim().length < 100) return null
      return {
        url: page.url,
        title: null,
        byline: null,
        markdown: fallback,
        sourceType: 'article',
        itemCount: 1,
      }
    }
    return {
      url: page.url,
      title: article.title ?? null,
      byline: article.author ?? null,
      markdown: stripHtml(article.content),
      sourceType: 'article',
      itemCount: 1,
    }
  } catch (err) {
    console.warn('[profile:fetch] Readability failed', { url: page.url, err })
    return null
  }
}

// ── Network + plumbing ─────────────────────────────────────────────

async function fetchPage(url: string): Promise<FetchedPageRaw | null> {
  try {
    return await invoke<FetchedPageRaw>('fetch_url', { url })
  } catch (err) {
    console.warn('[profile:fetch] fetch_url failed', { url, err })
    return null
  }
}

/** Crude HTML → text. Strips tags, decodes the handful of named
 * entities we see in practice. Good enough for RSS bodies and
 * Readability output; the LLM tolerates leftover whitespace fine. */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Dev console handle — verify fetch + parse against a real URL before
// the BootstrapDialog wires it up.
//   In DevTools:  await window.__fetchUrlAsMarkdown('https://blog.example.com')
if (import.meta.env.DEV) {
  ;(window as unknown as { __fetchUrlAsMarkdown: typeof fetchUrlAsMarkdown }).__fetchUrlAsMarkdown =
    fetchUrlAsMarkdown
}
