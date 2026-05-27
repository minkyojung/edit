// Compact markdown → DOM renderer for review surfaces.
//
// Used by the Review Panel's entry list (one-line previews) and the
// expanded diff view (multi-line before/after blocks). Also a
// candidate replacement for the inline review widget's raw-text
// `textContent` if we keep that surface around.
//
// This is NOT a full markdown engine. It handles the subset the LLM
// emits and the apply pipeline produces:
//
//   block:
//     `# h1` through `###### h6` headings
//     `* item` / `- item` / `+ item` single-level bullet lists
//     `> quote` blockquotes (multi-line, leading `> ` stripped)
//     plain paragraphs
//
//   inline:
//     `[label](url)`        → <a class="md-link" href="url">
//     `[label](note:slug)`  → <a class="md-wikilink">
//     `[[label]]`           → <a class="md-wikilink">
//     `**bold**`            → <strong>
//     anything else         → text
//
// Escape backslashes (`\[`, `\]`) are stripped before inline parsing
// — commonmark serializers escape `[[` to `\[\[` to dodge link-syntax
// ambiguity and we want the renderer to see the canonical form.
//
// Nested lists, tables, code fences, footnotes, etc. are out of
// scope. If the renderer encounters them it falls through to plain
// paragraphs — content is preserved, just unstyled.

/** Turn `md` into a DOM fragment. Caller appends to its container. */
export function renderMarkdownToFragment(md: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  // Blocks are separated by one or more blank lines (commonmark
  // convention). Trim outer whitespace so leading / trailing blank
  // lines in `md` don't produce empty blocks.
  const blocks = md.replace(/^\s+|\s+$/g, '').split(/\n{2,}/)
  for (const raw of blocks) {
    if (!raw.trim()) continue
    appendBlock(frag, raw)
  }
  return frag
}

/** Render `md` and return the HTML string. Convenience for places
 * that want to assign via `.innerHTML` rather than fragment append.
 * Less common — fragment is preferred because it preserves event
 * listeners if the caller attaches any after construction. */
export function renderMarkdownToHtml(md: string): string {
  const host = document.createElement('div')
  host.appendChild(renderMarkdownToFragment(md))
  return host.innerHTML
}

function appendBlock(parent: ParentNode, block: string): void {
  // Heading — `#` through `######` followed by space + content. We
  // peel the leading `#`s and pass the rest through inline parsing
  // so a heading like `### [Sera](note:..)` still renders the link.
  const heading = /^(#{1,6})\s+(.*)$/.exec(block.split('\n')[0])
  if (heading && block.split('\n').length === 1) {
    const level = heading[1].length
    const el = document.createElement(`h${level}`)
    appendInline(el, heading[2])
    parent.appendChild(el)
    return
  }

  // Bullet list — every line starts with `-` / `*` / `+`. Single
  // level only; nested lists fall through to the paragraph branch
  // (content preserved, just not indented).
  const lines = block.split('\n')
  if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
    const ul = document.createElement('ul')
    ul.className = 'md-list'
    for (const line of lines) {
      const m = /^\s*[-*+]\s+(.*)$/.exec(line)
      if (!m) continue
      const li = document.createElement('li')
      appendInline(li, m[1])
      ul.appendChild(li)
    }
    parent.appendChild(ul)
    return
  }

  // Blockquote — leading `>` on every line. Strip the marker, join,
  // and run as paragraph content (with inline parsing).
  if (lines.every((l) => /^\s*>\s?/.test(l))) {
    const bq = document.createElement('blockquote')
    bq.className = 'md-quote'
    const inner = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n')
    appendInline(bq, inner)
    parent.appendChild(bq)
    return
  }

  // Paragraph — anything else. Soft newlines inside a paragraph are
  // preserved as <br/> so multi-line LLM output reads as the author
  // intended.
  const p = document.createElement('p')
  p.className = 'md-para'
  const segments = block.split('\n')
  segments.forEach((seg, i) => {
    appendInline(p, seg)
    if (i < segments.length - 1) p.appendChild(document.createElement('br'))
  })
  parent.appendChild(p)
}

/** Inline content. Scans left-to-right, matching the longest known
 * pattern at each position. Order matters: wikilink (`[[X]]`) is
 * checked before regular link (`[X](url)`) so we don't half-match
 * the inner `[`.
 *
 * Backslash escapes on `[` / `]` are stripped upfront so PM-round-
 * tripped content (`\[\[Sera\]\]`) renders the same as canonical
 * (`[[Sera]]`). */
function appendInline(parent: ParentNode, raw: string): void {
  const text = stripBackslashEscapes(raw)
  let i = 0
  while (i < text.length) {
    // Wikilink [[label]]
    if (text[i] === '[' && text[i + 1] === '[') {
      const close = text.indexOf(']]', i + 2)
      if (close > 0) {
        const label = text.slice(i + 2, close).trim()
        if (label) {
          parent.appendChild(makeWikilinkAnchor(label))
          i = close + 2
          continue
        }
      }
    }

    // Standard link [label](url)
    if (text[i] === '[') {
      const labelEnd = findLabelEnd(text, i + 1)
      if (labelEnd > 0 && text[labelEnd + 1] === '(') {
        const urlEnd = text.indexOf(')', labelEnd + 2)
        if (urlEnd > 0) {
          const label = text.slice(i + 1, labelEnd)
          const url = text.slice(labelEnd + 2, urlEnd)
          parent.appendChild(makeLinkAnchor(label, url))
          i = urlEnd + 1
          continue
        }
      }
    }

    // Bold **text**
    if (text[i] === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2)
      if (close > 0) {
        const inner = text.slice(i + 2, close)
        if (inner) {
          const s = document.createElement('strong')
          s.textContent = inner
          parent.appendChild(s)
          i = close + 2
          continue
        }
      }
    }

    // No pattern at i — find the next position where one could start
    // and emit the in-between as plain text. Using indexOf for each
    // candidate is fine at our content lengths (snippets, not full
    // documents). Fallback to end-of-string when nothing remains.
    let next = text.length
    for (const ch of ['[', '*']) {
      const idx = text.indexOf(ch, i + 1)
      if (idx >= 0 && idx < next) next = idx
    }
    parent.appendChild(document.createTextNode(text.slice(i, next)))
    i = next
  }
}

/** Find the position of the `]` that closes a link label, accounting
 * for nested brackets inside the label (e.g. `[See [Sera] here]`).
 * Returns -1 when no balanced close exists. */
function findLabelEnd(text: string, from: number): number {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function makeWikilinkAnchor(label: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'md-wikilink'
  a.textContent = label
  // No href — the wikilink resolver runs at the editor's parse
  // boundary (Phase L1), and review surfaces don't need clickable
  // navigation from a preview. Treating these as visual link-styled
  // text keeps the renderer side-effect-free.
  return a
}

function makeLinkAnchor(label: string, url: string): HTMLAnchorElement {
  const a = document.createElement('a')
  if (url.startsWith('note:')) {
    a.className = 'md-wikilink'
  } else {
    a.className = 'md-link'
    a.href = url
    a.rel = 'noreferrer noopener'
  }
  a.textContent = label
  return a
}

function stripBackslashEscapes(text: string): string {
  // commonmark only escapes a fixed set of punctuation. We strip
  // the ones we care about for link parsing: `[` `]` `*`. Other
  // escapes pass through unchanged so the renderer doesn't mutate
  // unrelated content.
  return text.replace(/\\([[\]*])/g, '$1')
}
