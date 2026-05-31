// RSS / Atom feed adapter. Strategy:
//
//   1. Fetch the input URL.
//   2. If the body looks like XML (RSS or Atom), parse it directly.
//   3. Otherwise treat it as HTML and look for a feed-discovery link
//      (<link rel="alternate" type="application/rss+xml"|"atom+xml">).
//      If found, fetch that URL and parse.
//   4. Return one Document per feed entry, up to MAX_DOCS_PER_RUN.
//
// XML parsing uses strict 'application/xml' mode (not 'text/html') so
// CDATA blocks containing <p>, <a>, etc. survive intact — the HTML
// parser would otherwise rewrite them. Rust's fetch_url already
// strips BOM and XML-invalid control chars, so the parser doesn't
// reject otherwise-fine feeds.

import { createMarkdownContent } from 'defuddle/full'
import type { Document, FetchedPage } from './index'
import { fetchPage, MAX_DOCS_PER_RUN } from './index'
import { resolveUrl } from './html'

const ATOM_NS = 'http://www.w3.org/2005/Atom'
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/'
const DC_NS = 'http://purl.org/dc/elements/1.1/'

export async function fetchViaRss(inputUrl: string): Promise<Document[]> {
  const page = await fetchPage(inputUrl)
  if (page.status >= 400) return []

  // Direct hit: the input URL was already a feed.
  if (looksLikeFeed(page)) {
    return parseFeed(page.body, page.url)
  }

  // Indirect: input is HTML, look for a feed link in <head>.
  const feedUrl = discoverFeedUrl(page.body, page.url)
  if (!feedUrl) return []

  const feedPage = await fetchPage(feedUrl)
  if (feedPage.status >= 400) return []
  return parseFeed(feedPage.body, feedPage.url)
}

function looksLikeFeed(page: FetchedPage): boolean {
  const ct = (page.contentType ?? '').toLowerCase()
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom')) {
    return true
  }
  // Some hosts mis-serve feeds as text/html. Sniff the body prefix.
  const head = page.body.slice(0, 256).trimStart().toLowerCase()
  return head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed')
}

function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const links = doc.querySelectorAll('link[rel="alternate"]')
  for (const link of links) {
    const type = (link.getAttribute('type') ?? '').toLowerCase()
    const href = link.getAttribute('href')
    if (!href) continue
    if (type.includes('rss') || type.includes('atom') || type.includes('xml')) {
      return resolveUrl(href, baseUrl)
    }
  }
  return null
}

function parseFeed(body: string, feedUrl: string): Document[] {
  const xml = new DOMParser().parseFromString(body, 'application/xml')
  // DOMParser doesn't throw on malformed XML — it returns a doc with
  // a <parsererror> element. Treat that as "not a feed".
  if (xml.querySelector('parsererror')) return []

  // RSS 2.0: <rss><channel><item>...
  const rssItems = Array.from(xml.querySelectorAll('item'))
  if (rssItems.length > 0) {
    return rssItems.slice(0, MAX_DOCS_PER_RUN).map((el) => parseRssItem(el, feedUrl))
  }

  // Atom 1.0: <feed><entry>... — namespaced lookup so we don't match
  // arbitrary <entry> elements that happen to exist elsewhere.
  const atomEntries = Array.from(xml.getElementsByTagNameNS(ATOM_NS, 'entry'))
  if (atomEntries.length > 0) {
    return atomEntries.slice(0, MAX_DOCS_PER_RUN).map((el) => parseAtomEntry(el, feedUrl))
  }

  return []
}

function parseRssItem(el: Element, feedUrl: string): Document {
  const title = textOf(el, 'title') ?? '(untitled)'
  const link = textOf(el, 'link') ?? ''
  const pubDate = textOf(el, 'pubDate')
  const author =
    textOfNS(el, DC_NS, 'creator') ?? textOf(el, 'author') ?? undefined
  // content:encoded (namespaced) is the full body; <description> is
  // often just a summary. Prefer content:encoded when present.
  const contentHtml =
    textOfNS(el, CONTENT_NS, 'encoded') ?? textOf(el, 'description') ?? ''
  const sourceUrl = resolveUrl(link, feedUrl)
  return {
    sourceUrl,
    title: title.trim(),
    contentMarkdown: createMarkdownContent(contentHtml, sourceUrl),
    publishedAt: pubDate ?? undefined,
    author: author?.trim(),
  }
}

function parseAtomEntry(el: Element, feedUrl: string): Document {
  const title = textOfNS(el, ATOM_NS, 'title') ?? '(untitled)'
  // Atom links are attributes on <link>, not text content.
  const linkEl = Array.from(el.getElementsByTagNameNS(ATOM_NS, 'link')).find(
    (l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate',
  )
  const link = linkEl?.getAttribute('href') ?? ''
  const published =
    textOfNS(el, ATOM_NS, 'published') ?? textOfNS(el, ATOM_NS, 'updated')
  const author = textOfNS(el.getElementsByTagNameNS(ATOM_NS, 'author')[0] ?? el, ATOM_NS, 'name')
  const contentHtml =
    textOfNS(el, ATOM_NS, 'content') ?? textOfNS(el, ATOM_NS, 'summary') ?? ''
  const sourceUrl = resolveUrl(link, feedUrl)
  return {
    sourceUrl,
    title: title.trim(),
    contentMarkdown: createMarkdownContent(contentHtml, sourceUrl),
    publishedAt: published ?? undefined,
    author: author?.trim(),
  }
}

function textOf(parent: Element, tag: string): string | null {
  const node = parent.getElementsByTagName(tag)[0]
  return node?.textContent ?? null
}

function textOfNS(parent: Element, ns: string, local: string): string | null {
  const node = parent.getElementsByTagNameNS(ns, local)[0]
  return node?.textContent ?? null
}
