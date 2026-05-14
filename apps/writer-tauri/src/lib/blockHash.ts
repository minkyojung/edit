// Markdown block hashing — physical dedup for the ingest pipeline.
//
// Problem the file solves: the idle trigger used to re-send a
// daily note's *entire* body to the LLM on every pass. Adding one
// new line late in the day meant the LLM re-saw — and re-proposed
// edits for — every fact it had already filed. The wiki ended up
// with the same row stamped two or three times.
//
// Mechanism: split the body into blocks (paragraphs, list groups,
// headings), hash each one, persist the set of hashes already
// included in a successful ingest pass, and on the next pass only
// forward blocks whose hash isn't in the set. The LLM never sees
// the same paragraph twice, so it can't propose the same edit
// twice — regardless of prompt wording.
//
// Hash is SHA-256 of a normalized (trim + whitespace-collapsed)
// block text. Normalization keeps "오타 수정" (a trailing space,
// a doubled space inside) on the same hash; an actual content
// edit ("회의 했음" → "Q3 계획 정함") yields a fresh hash and is
// correctly re-ingested.
//
// Blocks are markdown-shaped, not ProseMirror nodes, because the
// ingest pipeline already operates on markdown (readDocMarkdown).
// Splitting at the markdown layer avoids a PM round-trip and means
// hashes are stable even if the editor's internal node IDs shift.

import { isEffectivelyEmpty } from './markdownText'

export interface MarkdownBlock {
  /** SHA-256 of the normalized block text, hex-encoded. Stable
   * across cosmetic whitespace changes; sensitive to meaningful
   * content edits. Used as the dedup key in ingestStore. */
  hash: string
  /** The block's original markdown source, preserved verbatim so
   * downstream consumers (the LLM prompt builder) can re-emit it
   * without losing structure. Trim/collapse happens only inside
   * `normalize` for hashing — the text shipped to the LLM stays
   * intact. */
  text: string
}

const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const HEADING_LINE_RE = /^\s*#{1,6}\s+/

/** Collapse runs of whitespace (including newlines) to a single
 * space and trim ends. Two blocks that differ only in cosmetic
 * whitespace will share a hash, so a stray trailing space on
 * re-edit doesn't trip a needless re-ingest. Meaningful character
 * changes shift the hash. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Split a markdown body into top-level blocks. The split rules
 * match how a writer mentally groups content:
 *
 *   - Blank line(s) separate one block from the next.
 *   - A run of adjacent list items (no blank line between them)
 *     is one block — users don't paragraph-break between bullets.
 *   - Headings start a new block even without a blank line above.
 *   - Whitespace-only segments are skipped (matches
 *     isEffectivelyEmpty so legacy ZWS-only seed paragraphs don't
 *     pollute the hash set).
 *
 * The returned blocks preserve their original text so the LLM
 * receives them verbatim. */
export async function splitBlocks(markdown: string): Promise<MarkdownBlock[]> {
  if (!markdown || isEffectivelyEmpty(markdown)) return []

  const lines = markdown.split('\n')
  const groups: string[] = []
  let buf: string[] = []
  let inList = false

  const flush = () => {
    if (buf.length === 0) return
    const text = buf.join('\n')
    if (!isEffectivelyEmpty(text)) groups.push(text)
    buf = []
  }

  for (const line of lines) {
    const blank = line.trim().length === 0
    const isList = LIST_LINE_RE.test(line)
    const isHeading = HEADING_LINE_RE.test(line)

    if (blank) {
      flush()
      inList = false
      continue
    }
    if (isHeading) {
      flush()
      inList = false
      buf.push(line)
      // Heading is its own block; flush immediately so the next
      // line (often the paragraph under it) starts fresh.
      flush()
      continue
    }
    if (isList) {
      // First list item after non-list content closes the previous
      // block before opening a new (list-grouped) one.
      if (!inList) flush()
      inList = true
      buf.push(line)
      continue
    }
    // Plain line. If we were in a list, close it — a paragraph
    // immediately after a list belongs to its own block.
    if (inList) {
      flush()
      inList = false
    }
    buf.push(line)
  }
  flush()

  const blocks: MarkdownBlock[] = []
  for (const text of groups) {
    const hash = await sha256Hex(normalize(text))
    blocks.push({ hash, text })
  }
  return blocks
}

/** Filter the body's blocks against a set of hashes already seen.
 * Returns the blocks that are new (caller forwards their `text` to
 * the LLM) plus the *full* hash list (caller persists this back to
 * the store so the next pass remembers everything currently in the
 * doc, not just the new arrivals).
 *
 * Returning `allHashes` rather than just the new ones is what makes
 * deletions self-healing: if the user deletes a paragraph, its hash
 * drops out of `allHashes` on the next pass, and a re-pasted copy
 * of the same paragraph would correctly be treated as new again. */
export async function pickNewBlocks(
  markdown: string,
  seenHashes: ReadonlySet<string>,
): Promise<{ newBlocks: MarkdownBlock[]; allHashes: string[] }> {
  const blocks = await splitBlocks(markdown)
  const newBlocks: MarkdownBlock[] = []
  const allHashes: string[] = []
  for (const b of blocks) {
    allHashes.push(b.hash)
    if (!seenHashes.has(b.hash)) newBlocks.push(b)
  }
  return { newBlocks, allHashes }
}
