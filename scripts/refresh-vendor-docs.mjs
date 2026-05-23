#!/usr/bin/env node
// Refresh local cache of Milkdown's official documentation.
//
// Reads every doc URL from https://milkdown.dev/sitemap.xml, extracts the raw
// markdown source exposed via the Next.js __NEXT_DATA__ payload, and writes
// it to docs/vendor/milkdown/<section>/<slug>.md with frontmatter.
//
// Developer-only resource. Not bundled into the product.
//
// Run: `node scripts/refresh-vendor-docs.mjs`

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(__dirname)
const OUT_DIR = join(ROOT, 'docs', 'vendor', 'milkdown')
const SITEMAP_URL = 'https://milkdown.dev/sitemap.xml'
const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/Milkdown/website/main/docs'
// URL section → GitHub source directory (most match 1:1; blog is the exception).
const GITHUB_SECTION_DIR = { blog: 'blogs' }
const MILKDOWN_VERSION = '7.20.0'
const TODAY = new Date().toISOString().slice(0, 10)
const CONCURRENCY = 4

const DOC_PATH_RE = /^\/docs\/(guide|plugin|recipes|api|blog|playground)\/([^/]+)\/?$/
const SECTION_ORDER = ['guide', 'plugin', 'recipes', 'api', 'blog', 'playground']

async function fetchSitemap() {
  const res = await fetch(SITEMAP_URL)
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`)
  const xml = await res.text()
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
}

async function fetchFromNextData(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  )
  if (!match) return null
  const data = JSON.parse(match[1])
  const content = data?.props?.pageProps?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}

async function fetchFromGithub(section, slug) {
  const dir = GITHUB_SECTION_DIR[section] ?? section
  const rawUrl = `${GITHUB_RAW_BASE}/${dir}/${encodeURIComponent(slug)}.md`
  const res = await fetch(rawUrl)
  if (!res.ok) throw new Error(`GitHub raw HTTP ${res.status}`)
  return await res.text()
}

async function fetchPageMarkdown(url, section, slug) {
  // Most pages expose the raw markdown via Next.js __NEXT_DATA__.
  // Blog pages do not — fall back to the GitHub source.
  const fromNext = await fetchFromNextData(url)
  if (fromNext) return fromNext
  return await fetchFromGithub(section, slug)
}

function extractTitle(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

function buildFrontmatter(sourceUrl, title) {
  return [
    '---',
    `source: ${sourceUrl}`,
    `fetched: ${TODAY}`,
    `milkdown_version: ${MILKDOWN_VERSION}`,
    `title: ${JSON.stringify(title)}`,
    '---',
    '',
  ].join('\n')
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function buildIndex(entries) {
  const bySection = {}
  for (const e of entries) {
    if (!e) continue
    ;(bySection[e.section] ??= []).push(e)
  }
  for (const list of Object.values(bySection)) {
    list.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  const lines = [
    '# Milkdown Docs Cache — Index',
    '',
    `_Cached from https://milkdown.dev/docs/ on ${TODAY}. Milkdown version ${MILKDOWN_VERSION}._`,
    '',
    '> Developer-only reference. Not bundled into the product.',
    '> Refresh: `node scripts/refresh-vendor-docs.mjs`',
    '',
  ]
  for (const section of SECTION_ORDER) {
    const list = bySection[section]
    if (!list || list.length === 0) continue
    lines.push(`## ${section}`, '')
    for (const e of list) {
      lines.push(`- [${e.title}](./${section}/${e.slug}.md) — ${e.url}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function main() {
  console.log(`→ Fetching sitemap from ${SITEMAP_URL}`)
  const urls = await fetchSitemap()

  const docUrls = []
  for (const u of urls) {
    let path
    try {
      path = new URL(u).pathname
    } catch {
      continue
    }
    const m = path.match(DOC_PATH_RE)
    if (m) docUrls.push({ url: u, section: m[1], slug: m[2] })
  }

  console.log(`→ Found ${docUrls.length} doc URLs`)

  let okCount = 0
  let failCount = 0

  const entries = await mapWithConcurrency(docUrls, CONCURRENCY, async (item) => {
    const { url, section, slug } = item
    try {
      const content = await fetchPageMarkdown(url, section, slug)
      const title = extractTitle(content, slug)
      const outFile = join(OUT_DIR, section, `${slug}.md`)
      await mkdir(dirname(outFile), { recursive: true })
      const body = buildFrontmatter(url, title) + '\n' + content.trimEnd() + '\n'
      await writeFile(outFile, body, 'utf8')
      console.log(`  ok  ${section}/${slug}`)
      okCount++
      return { section, slug, title, url }
    } catch (err) {
      console.error(`  err ${section}/${slug}: ${err.message}`)
      failCount++
      return null
    }
  })

  const indexPath = join(OUT_DIR, 'INDEX.md')
  await writeFile(indexPath, buildIndex(entries), 'utf8')
  console.log(`→ Wrote ${indexPath}`)

  console.log(`\nDone. ${okCount} ok, ${failCount} failed.`)
  if (failCount > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
