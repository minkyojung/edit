// URL → markdown for the Profile bootstrap pipeline.
//
// Routes the input URL through one of three extraction paths,
// chosen by host pattern:
//
//   - RSS/Atom feed (Substack, Medium, Ghost, WordPress, anything
//     advertising a feed URL) → batched extraction of recent posts.
//     One paste gets the user a corpus, not a single sample.
//   - Article (everything else) → Mozilla Readability via the
//     native browser DOM. Strips nav/footers/ads to give the LLM
//     the prose.
//   - oEmbed for x.com / twitter.com — v0 stub. We return the raw
//     status URL so the LLM can at least cite the source; full
//     timeline import is deferred to a ZIP path later.
//
// All routes converge on the same return shape so the caller
// (`extractProfile`) treats every source as "one markdown blob
// with metadata."
//
// Implementation note (E.2 → fix): we originally used
// `@extractus/article-extractor` + `rss-parser`, but both pull in
// Node-only dependencies (`fs`, `events`, etc.) that Vite
// externalises for the browser build, which throws at runtime
// inside the Tauri WebView. We now use `@mozilla/readability`
// (pure browser, the actual Firefox Reader View engine) for
// articles, and a hand-rolled RSS/Atom parser using the native
// `DOMParser` for feeds. Both are zero-Node-dep.

import { invoke } from '@tauri-apps/api/core'
import { Readability } from '@mozilla/readability'

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
    const rss = parseRssBody(page.url, page.body)
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

  return extractArticle(page)
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

/** Parse RSS 2.0 or Atom XML into our FetchedSource shape using
 * the browser-native DOMParser in `application/xml` mode. Handles:
 *
 *   <rss><channel><item>...</item></channel></rss>     (RSS 2.0)
 *   <feed><entry>...</entry></feed>                    (Atom 1.0)
 *
 * Why strict XML over `text/html`: HTML5's parser drops CDATA
 * content (treats `<![CDATA[...]]>` as a bogus comment), and
 * namespaced tags (`dc:creator`, `content:encoded`) get mangled.
 * Real-world feeds put titles and post bodies INSIDE CDATA, so
 * HTML-mode parsing silently loses the actual content.
 *
 * Strict XML handles CDATA correctly; the historical "Substack
 * rejected as invalid XML" failure was actually a leading BOM
 * stripped now by the Rust fetch layer (fetch_url.rs). For
 * namespaced fields we use `getElementsByTagNameNS` — querySelector
 * with `content\:encoded` works in HTML mode but not reliably in
 * XML mode where namespaces are honoured.
 *
 * Namespace URIs are stable per the RSS / Atom / Dublin Core specs;
 * we hard-code them rather than re-discovering from the document
 * declaration each time. */
const NS_CONTENT = 'http://purl.org/rss/1.0/modules/content/'
const NS_DC = 'http://purl.org/dc/elements/1.1/'
const NS_ATOM = 'http://www.w3.org/2005/Atom'

function parseRssBody(finalUrl: string, body: string): FetchedSource | null {
  try {
    const doc = new DOMParser().parseFromString(body, 'application/xml')
    const parseError = doc.querySelector('parsererror')
    if (parseError) {
      console.warn('[profile:fetch] XML parse error', {
        finalUrl,
        msg: parseError.textContent?.slice(0, 200),
        bodyStartsWith: body.slice(0, 500),
      })
      return null
    }

    const rssRoot = doc.documentElement
    const rootName = rssRoot.localName.toLowerCase()
    if (rootName !== 'rss' && rootName !== 'feed') {
      console.warn('[profile:fetch] not a feed', {
        finalUrl,
        rootElement: rootName,
        bodyStartsWith: body.slice(0, 500),
      })
      return null
    }
    const isAtom = rootName === 'feed'
    const feedTitle = textOf(
      isAtom
        ? doc.getElementsByTagNameNS(NS_ATOM, 'title')[0] ?? null
        : doc.querySelector('channel > title'),
    )
    const itemNodes = isAtom
      ? Array.from(doc.getElementsByTagNameNS(NS_ATOM, 'entry'))
      : Array.from(doc.querySelectorAll('channel > item'))
    const items = itemNodes.slice(0, MAX_RSS_ITEMS)
    if (items.length === 0) return null

    const sections: string[] = []
    let bylineCandidate: string | null = null
    for (const item of items) {
      const title = textOf(firstChildByLocalName(item, 'title'))
      const date = textOf(
        firstChildByLocalName(item, isAtom ? 'published' : 'pubDate') ??
          firstChildByLocalName(item, 'updated'),
      )
      // Full post body: <content:encoded> (RSS) or <content> (Atom).
      // Fall back to <description> (RSS) or <summary> (Atom) for
      // feeds that don't carry full text.
      const fullBody =
        textOf(firstByNS(item, NS_CONTENT, 'encoded')) ??
        (isAtom ? textOf(firstChildByLocalName(item, 'content')) : null)
      const summary = textOf(
        firstChildByLocalName(item, isAtom ? 'summary' : 'description'),
      )
      const bodyText = stripHtml(fullBody || summary || '')
      if (!bylineCandidate) {
        bylineCandidate =
          textOf(firstByNS(item, NS_DC, 'creator')) ??
          (isAtom
            ? textOf(firstByLocalName(item, 'name'))
            : null) ??
          textOf(firstChildByLocalName(item, 'author'))
      }
      const section = [
        title ? `## ${title}` : '##',
        date ? `*${date}*` : '',
        bodyText,
      ]
        .filter((s) => s.trim().length > 0)
        .join('\n\n')
      if (section.trim().length > 0) sections.push(section)
    }
    if (sections.length === 0) return null

    return {
      url: finalUrl,
      title: feedTitle,
      byline: bylineCandidate,
      markdown: sections.join('\n\n---\n\n'),
      sourceType: 'rss',
      itemCount: items.length,
    }
  } catch (err) {
    console.warn('[profile:fetch] RSS parse failed', { finalUrl, err })
    return null
  }
}

/** Find the first direct child of `parent` whose localName matches
 * (case-insensitive). Used for non-namespaced RSS/Atom fields where
 * default-namespace lookup via querySelector is unreliable in XML
 * mode (Atom puts everything in the Atom namespace by default). */
function firstChildByLocalName(parent: Element, name: string): Element | null {
  const target = name.toLowerCase()
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === target) return child
  }
  return null
}

/** Like firstChildByLocalName but searches all descendants. */
function firstByLocalName(parent: Element, name: string): Element | null {
  const target = name.toLowerCase()
  const all = parent.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName.toLowerCase() === target) return all[i]
  }
  return null
}

/** Find first element in `parent` with the given namespace URI +
 * localName. Used for namespaced fields like content:encoded and
 * dc:creator that querySelector can't address reliably in XML mode. */
function firstByNS(parent: Element, ns: string, localName: string): Element | null {
  const list = parent.getElementsByTagNameNS(ns, localName)
  return list.length > 0 ? list[0] : null
}

function textOf(el: Element | null | undefined): string | null {
  if (!el) return null
  const t = el.textContent?.trim()
  return t && t.length > 0 ? t : null
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

/** Run Mozilla Readability against a fetched HTML page. The engine
 * mutates the input document, so we parse the body into a fresh
 * Document first. Readability needs a `baseURI` to resolve relative
 * links — we set it via the parsed doc's documentURI when possible. */
function extractArticle(page: FetchedPageRaw): FetchedSource | null {
  try {
    const doc = new DOMParser().parseFromString(page.body, 'text/html')
    // Some readability heuristics use the doc's baseURI to score
    // links. Inject a <base> tag pointing at the source URL so
    // relative paths resolve correctly.
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base')
      base.setAttribute('href', page.url)
      doc.head?.prepend(base)
    }
    const reader = new Readability(doc)
    const article = reader.parse()
    if (!article || !article.content) {
      // Last-resort: strip all HTML and return whatever text the
      // page had. Better than nothing for thin home pages.
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
      byline: article.byline ?? null,
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
