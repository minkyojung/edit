// Text-prep utilities for the bootstrap Import pipeline. Each
// function is pure (no state, no I/O) so it can be unit tested in
// isolation and reused by adjacent sources (e.g. the future URL
// fetcher, which lands HTML-converted markdown that needs the same
// chunking treatment).
//
// What's intentionally out of scope here:
//
//   - File reading. `runImport` (D.2.2) owns the Tauri fs call.
//   - LLM invocation. `bootstrapIngest` owns the LLM dance.
//   - Format detection beyond extension. .md/.txt/.json all flow
//     through the same path; the LLM tolerates JSON-as-text fine
//     and trying to "smartly" parse JSON would risk losing useful
//     context (e.g. Notion export wrappers).

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

/** Strip the leading YAML frontmatter block from a markdown / text
 * file, returning the body unchanged. Obsidian / Hugo / Jekyll all
 * share this convention:
 *
 *   ---
 *   title: foo
 *   tags: [bar]
 *   ---
 *   <body starts here>
 *
 * Only the very first block is removed; standalone `---` separators
 * mid-document (horizontal rules) are untouched. If the file
 * doesn't open with `---\n` the input is returned as-is.
 *
 * Why strip at all: frontmatter fields like `title: foo` would
 * otherwise be ingested as plain facts ("foo is a title"), and
 * custom plugin fields (Dataview, Templater) are pure noise to
 * the wiki extractor. The cost — losing tag/alias signals — is
 * acceptable for v0.0.1; a later pass can surface those as a
 * dedicated context block. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, '')
}

const DEFAULT_MAX_BYTES = 50_000

const encoder = new TextEncoder()
const byteLength = (s: string): number => encoder.encode(s).length

/** Split `text` into chunks where each chunk's UTF-8 byte length is
 * at most `maxBytes`. The walk is hierarchical so chunks stay at
 * natural reading boundaries when possible:
 *
 *   1. Split on blank lines (`\n\n`) — paragraph boundaries.
 *   2. If a single paragraph is still too big, split on `\n` —
 *      line boundaries.
 *   3. If a single line is still too big, force-split at the
 *      maxBytes boundary (without breaking mid-codepoint).
 *
 * Inputs shorter than `maxBytes` round-trip unchanged (single-
 * element array). Trailing whitespace between joined segments is
 * normalised to a single `\n\n` / `\n` so re-assembled chunks
 * don't drift in length.
 *
 * Why bytes not chars: LLM context limits are token-shaped, but
 * tokens correlate more closely with UTF-8 byte length than with
 * UTF-16 char count (Korean and emoji are 3+ bytes / char). A
 * char-count chunker would happily produce chunks that overflow
 * the model's window when the input is mostly multibyte. */
export function chunkText(text: string, maxBytes = DEFAULT_MAX_BYTES): string[] {
  if (maxBytes <= 0) throw new RangeError('chunkText: maxBytes must be > 0')
  if (byteLength(text) <= maxBytes) return [text]

  const chunks: string[] = []
  let current = ''

  const flushCurrent = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = ''
    }
  }

  const pushSegment = (segment: string, joiner: string) => {
    if (segment.length === 0) return
    const next = current.length === 0 ? segment : current + joiner + segment
    if (byteLength(next) <= maxBytes) {
      current = next
      return
    }
    // Segment alone may still be too big — flush what we have and
    // recurse with the finer-grained splitter.
    flushCurrent()
    if (byteLength(segment) <= maxBytes) {
      current = segment
    } else if (joiner === '\n\n') {
      for (const line of segment.split('\n')) pushSegment(line, '\n')
    } else if (joiner === '\n') {
      for (const piece of forceSplit(segment, maxBytes)) chunks.push(piece)
    } else {
      // Already at the byte-boundary splitter — guaranteed to fit.
      chunks.push(segment)
    }
  }

  for (const para of text.split('\n\n')) pushSegment(para, '\n\n')
  flushCurrent()
  return chunks
}

/** Last-resort splitter for a single line that exceeds maxBytes.
 * Walks the string character-by-character, accumulating into the
 * current piece until adding the next codepoint would exceed the
 * limit, then starts a new piece. This guarantees no chunk crosses
 * the byte limit AND no chunk breaks a multibyte character. */
function forceSplit(line: string, maxBytes: number): string[] {
  const out: string[] = []
  let buf = ''
  let bufBytes = 0
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length
    if (bufBytes + chBytes > maxBytes && buf.length > 0) {
      out.push(buf)
      buf = ''
      bufBytes = 0
    }
    buf += ch
    bufBytes += chBytes
  }
  if (buf.length > 0) out.push(buf)
  return out
}

/** Derive a stable, short source label from an absolute file path.
 * The label flows through to `ingestStore.enqueue` so it shows up
 * on the review banner — full system paths would leak user-private
 * directory structure and be unwieldy in the UI. Examples:
 *
 *   /Users/foo/Notes/sarah.md  →  imported/sarah.md
 *   C:\Users\foo\notes\bar.txt →  imported/bar.txt
 *   sarah.md                   →  imported/sarah.md  (already bare)
 *
 * Falls back to `imported/note` for empty / whitespace-only paths
 * so the label is never blank. */
export function inferSourceLabel(path: string): string {
  const cleaned = path.trim()
  if (cleaned.length === 0) return 'imported/note'
  // Normalise both POSIX and Windows separators in one pass.
  const segments = cleaned.split(/[/\\]/).filter((s) => s.length > 0)
  const basename = segments[segments.length - 1] ?? 'note'
  return `imported/${basename}`
}
