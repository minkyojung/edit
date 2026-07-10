// HTML → Markdown, for pasting rich web content into the editor.
//
// The counterpart to markdownToHtml (copy-out). Pipeline:
//
//   parse → normalizeDom (clean to content) → Turndown → tidyMarkdown
//
// Clipboard HTML from browsers / Word / Google Docs mixes CONTENT with
// PRESENTATION (manual spacing, wrapper links, style attributes).
// Markdown wants only content, so the fix is NOT a growing pile of
// regex hacks on Turndown's output — it's one DOM normalization pass
// (an ordered list of small rules) that reduces the parsed HTML to
// content before a thin Turndown serializes it. New messy-HTML patterns
// become a new rule in that one place.
//
// Note: this is a FRAGMENT converter, not an article extractor. We do
// NOT run Readability/Defuddle here — the user selected a specific span
// of a page and expects THAT, not a re-extracted "main article".
//
// Turndown is configured to our conventions so pasted markdown matches
// what the editor writes elsewhere: `-` bullets, ATX headings, fenced
// code. GFM (tables, strikethrough, task lists) comes from the plugin.

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const service = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  linkStyle: 'inlined',
})
service.use(gfm)

// Turndown's default list item emits `-   item` (marker + 3 spaces) and
// indents nested lists by 4 spaces. Override it to our vault's style —
// `- item` (single space) and 2-space nesting — so pasted lists match
// hand-written ones. Mirrors Turndown's built-in rule, only the spacing
// changes.
service.addRule('listItem', {
  filter: 'li',
  replacement: (content, node, options) => {
    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '\n')
      .replace(/\n/gm, '\n  ')
    let prefix = options.bulletListMarker + ' '
    const parent = node.parentNode as HTMLElement | null
    if (parent?.nodeName === 'OL') {
      const start = parent.getAttribute('start')
      const index = Array.prototype.indexOf.call(parent.children, node)
      prefix = `${start ? Number(start) + index : index + 1}. `
    }
    return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '')
  },
})

// ─── DOM normalization ──────────────────────────────────────────────
// Each rule mutates the parsed document in place, reducing it toward
// pure content. Order matters (later rules see earlier rules' output).
// This is THE place to handle a new messy-HTML pattern.

type NormalizeRule = (doc: Document) => void

/** script / style / comments / head — never content. */
const removeNonContent: NormalizeRule = (doc) => {
  doc
    .querySelectorAll('script, style, noscript, meta, link, title, head')
    .forEach((el) => el.remove())
  // HTML comments (Word/Office paste is full of them).
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  comments.forEach((c) => c.parentNode?.removeChild(c))
}

/** Empty <p>/<div> — content is only <br>, &nbsp; or whitespace. These
 * are the "manual line spacing" artifacts web editors insert (Substack
 * enter-spacing, Word). Markdown can't express vertical space, so drop
 * them instead of letting Turndown emit a blank line per empty block —
 * that pile-up is exactly the "extra line breaks" seen on paste. */
const dropEmptyBlocks: NormalizeRule = (doc) => {
  doc.querySelectorAll('p, div').forEach((el) => {
    // Keep blocks that carry real content even without text.
    if (el.querySelector('img, video, audio, iframe, table, pre, hr, ul, ol')) return
    const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim()
    if (text === '') el.remove()
  })
}

/** A link that contains image(s) but no visible text — a decorative
 * image wrapper. Substack links every article image (often through a
 * nested figure/picture/div, and to a different-resolution URL than the
 * <img>), which Turndown renders as `[ … ](href)` around the image,
 * leaving orphaned `[`/`]`/URL text in the editor. Replace the whole
 * link with just its image(s), dropping the wrapper and the href. */
const unwrapImageLinks: NormalizeRule = (doc) => {
  doc.querySelectorAll('a').forEach((a) => {
    if ((a.textContent ?? '').trim() !== '') return
    const imgs = Array.from(a.querySelectorAll('img'))
    if (imgs.length === 0) return
    a.replaceWith(...imgs)
  })
}

/** Elements hidden in the source (display:none / hidden / aria-hidden).
 * Turndown has no layout model, so their text would leak into the paste
 * as visible content. Remove them before anything else reads text. */
const removeHidden: NormalizeRule = (doc) => {
  doc
    .querySelectorAll(
      '[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]',
    )
    .forEach((el) => el.remove())
}

/** Recover style-based formatting. Google Docs and Word express bold /
 * italic as inline `style` (font-weight / font-style) on spans rather
 * than <strong>/<em>, so Turndown — which only reads semantic tags —
 * drops the formatting entirely. Wrap such elements' content in the
 * matching semantic tag so it survives. */
const styleToSemantic: NormalizeRule = (doc) => {
  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style') ?? ''
    const weight = /font-weight\s*:\s*(bold|\d{3})/i.exec(style)
    const isBold = weight != null && (weight[1] === 'bold' || Number(weight[1]) >= 600)
    const isItalic = /font-style\s*:\s*italic/i.test(style)
    if (!isBold && !isItalic) return
    let inner: Node = doc.createDocumentFragment()
    while (el.firstChild) inner.appendChild(el.firstChild)
    if (isItalic) {
      const em = doc.createElement('em')
      em.appendChild(inner)
      inner = em
    }
    if (isBold) {
      const strong = doc.createElement('strong')
      strong.appendChild(inner)
      inner = strong
    }
    el.appendChild(inner)
  })
}

const NORMALIZE_RULES: NormalizeRule[] = [
  removeNonContent,
  removeHidden,
  unwrapImageLinks,
  styleToSemantic,
  dropEmptyBlocks,
]

function normalizeDom(doc: Document): void {
  for (const rule of NORMALIZE_RULES) rule(doc)
}

/** Whitespace tidy on the serialized markdown. Structural fixes belong
 * in the DOM rules above; this only normalizes spacing:
 *   - blank out whitespace-only lines (Turndown emits `  ` spacer lines
 *     between loose-list items — the extra gap seen in pasted lists)
 *   - collapse a run of blank lines down to a single paragraph break
 * A whitespace-only line is never meaningful content, so this is safe;
 * trailing-space hard breaks (`text  `) are untouched (they have text). */
function tidyMarkdown(md: string): string {
  return md
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Convert a clipboard HTML fragment to markdown using our conventions.
 * Pure and synchronous — image srcs are left as-is (localization to the
 * vault happens separately, on the async path). */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  normalizeDom(doc)
  return tidyMarkdown(service.turndown(doc.body))
}

/** Whether a clipboard HTML payload carries real structure/formatting
 * worth converting. Plain-text copies often still ship a trivial
 * `<meta><span>…</span>` wrapper; converting those would only risk
 * mangling, so the paste handler falls back to text/plain for them. */
export function isRichHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (
    doc.body.querySelector(
      'h1, h2, h3, h4, h5, h6, ul, ol, li, table, blockquote, pre, img, a, strong, em, b, i, code',
    ) != null
  )
}
