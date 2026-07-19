// Sources layer — persist fetched posts as markdown files in the
// vault, then re-read them on subsequent pipeline runs so we never
// re-fetch the same URL.
//
// Layout inside the vault:
//
//   sources/
//   ├── _index.json                          ← which imports happened
//   └── <namespace>/                         ← one folder per import
//       ├── 2026-04-15--ai-tools-review.md   ← one file per post
//       └── ...
//
// Each post file is plain markdown with a small YAML frontmatter
// block. Frontmatter holds the per-post metadata (sourceUrl, title,
// publishedAt, …); body is the cleaned text the LLM consumes.
//
// _index.json is the registry — one entry per import the user has
// done. It lets the pipeline answer "do I already have posts from
// this URL?" without scanning the folder tree, and gives us a place
// to attach future metadata (last_analyzed, manual title, etc).

import { composeFrontmatter, splitFrontmatter } from '@/lib/frontmatter'
import {
  listVaultDir,
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import type { Document } from './adapters'

const SOURCES_ROOT = 'sources'
const INDEX_PATH = `${SOURCES_ROOT}/_index.json`

interface SourceIndex {
  imports: SourceImport[]
}

interface SourceImport {
  /** The URL the user originally pasted. */
  inputUrl: string
  /** Which adapter handled it. */
  adapter: string
  /** ISO timestamp of the fetch. */
  fetchedAt: string
  /** Vault-relative paths of the post files this import wrote. */
  files: string[]
}

/** Persist a freshly-fetched batch of documents to the vault and
 * append the import record to _index.json. Returns the vault-relative
 * paths the documents were written to. */
export async function saveSources(
  documents: Document[],
  adapter: string,
  inputUrl: string,
): Promise<string[]> {
  if (documents.length === 0) return []

  const namespace = namespaceFor(inputUrl)
  const fetchedAt = new Date().toISOString()
  const usedNames = new Set<string>()
  const writtenPaths: string[] = []

  for (const doc of documents) {
    const baseName = makeFilename(doc)
    const name = dedupeName(baseName, usedNames)
    usedNames.add(name)
    const relPath = `${SOURCES_ROOT}/${namespace}/${name}`
    const fileContent = serialiseSourceFile(doc, adapter, fetchedAt)
    await writeVaultFile(relPath, fileContent)
    writtenPaths.push(relPath)
  }

  await appendIndexEntry({
    inputUrl,
    adapter,
    fetchedAt,
    files: writtenPaths,
  })

  return writtenPaths
}

/** Load every persisted source document from the vault. Returns
 * Documents in the same shape the adapters produce, so downstream
 * code (the pipeline's section prompts) doesn't have to know whether
 * the input came from a live fetch or disk. */
export async function readAllSources(): Promise<Document[]> {
  const index = await readIndex()
  if (!index || index.imports.length === 0) return []

  const docs: Document[] = []
  for (const entry of index.imports) {
    for (const relPath of entry.files) {
      try {
        const raw = await readVaultFile(relPath)
        const parsed = parseSourceFile(raw)
        if (parsed) docs.push(parsed)
      } catch (err) {
        // A missing file just means the user deleted it — skip and
        // continue. Other errors get logged for diagnosis but don't
        // abort the whole read; partial sources are still useful.
        console.warn('[profile] source read failed', { relPath, err })
      }
    }
  }
  return docs
}

/** True when at least one persisted source exists. The pipeline uses
 * this to decide between cache-hit (read from disk) and cold-fetch. */
export async function hasAnySources(): Promise<boolean> {
  if (!(await vaultFileExists(INDEX_PATH))) return false
  const index = await readIndex()
  return !!index && index.imports.length > 0
}

// ── helpers ───────────────────────────────────────────────────────

async function readIndex(): Promise<SourceIndex | null> {
  if (!(await vaultFileExists(INDEX_PATH))) return null
  try {
    const raw = await readVaultFile(INDEX_PATH)
    return JSON.parse(raw) as SourceIndex
  } catch (err) {
    console.warn('[profile] index parse failed, treating as empty', err)
    return null
  }
}

async function appendIndexEntry(entry: SourceImport): Promise<void> {
  const current = (await readIndex()) ?? { imports: [] }
  current.imports.push(entry)
  await writeVaultFile(INDEX_PATH, JSON.stringify(current, null, 2) + '\n')
}

/** Derive a folder name from the input URL. Hostname becomes the
 * leading segment; if the URL has a meaningful first path segment
 * (e.g. substack newsletter slug) it gets appended so two newsletters
 * on the same platform don't collide. */
function namespaceFor(inputUrl: string): string {
  try {
    const u = new URL(inputUrl)
    const host = slugify(u.hostname)
    const firstSeg = u.pathname.split('/').filter(Boolean)[0]
    if (firstSeg && !looksLikeFilename(firstSeg)) {
      return `${host}-${slugify(firstSeg)}`
    }
    return host
  } catch {
    return slugify(inputUrl).slice(0, 64) || 'unknown'
  }
}

/** Build a sortable, human-readable filename for a single post.
 * Format: `<YYYY-MM-DD>--<slug>.md`. Date prefix from publishedAt
 * when available (else today), so a `ls` of the folder lists posts
 * chronologically.
 *
 * Slug length is capped in BYTES, not JS chars: APFS NAME_MAX is
 * ~255 bytes, and one Korean char is 3 UTF-8 bytes, so a 60-char
 * Korean slug occupies 180 bytes — close enough to the limit that
 * the prefix + suffix can push us over. Capping at 120 bytes
 * (~40 Korean chars or ~120 ASCII chars) leaves comfortable
 * headroom for the `.md` + date prefix and avoids the silent
 * truncation that previously left index entries pointing at files
 * the filesystem had shortened. */
function makeFilename(doc: Document): string {
  const date = formatDate(doc.publishedAt) ?? formatDate(new Date().toISOString())!
  const rawSlug = slugify(doc.title)
  const truncated = truncateByBytes(rawSlug, 120).replace(/-+$/, '')
  const slug = truncated || 'untitled'
  return `${date}--${slug}.md`
}

/** Trim a string so its UTF-8 encoded length is at most `maxBytes`.
 * Iterates by Unicode codepoint (so multi-byte chars are kept whole;
 * we never produce a half-byte sequence). */
function truncateByBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(input).length <= maxBytes) return input

  let bytes = 0
  let endCharIndex = 0
  for (const ch of input) {
    const chBytes = encoder.encode(ch).length
    if (bytes + chBytes > maxBytes) break
    bytes += chBytes
    endCharIndex += ch.length
  }
  return input.slice(0, endCharIndex)
}

function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name
  let n = 2
  const base = name.replace(/\.md$/, '')
  while (used.has(`${base}-${n}.md`)) n++
  return `${base}-${n}.md`
}

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // YYYY-MM-DD in UTC. Avoids the timezone surprise where a post
  // published just after midnight UTC ends up on the previous local
  // day in some users' filesystem.
  return d.toISOString().slice(0, 10)
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function looksLikeFilename(seg: string): boolean {
  // Skip path segments that are clearly post URLs (`/p/...`,
  // `/posts/...`) — those are not "newsletter identity", just article
  // ids. Using them as namespaces would scatter one user's posts
  // across many folders.
  return /^(p|post|posts|article|articles|entry|read|blog)$/i.test(seg)
}

// ── frontmatter serialisation ─────────────────────────────────────

type ParsedSource = Document

/** Compose the on-disk markdown for a single source file. Field order is
 * fixed by the object literal; `composeFrontmatter` drops the absent
 * optional fields. `sourceUrl` is always present, so a block is always
 * emitted. */
function serialiseSourceFile(
  doc: Document,
  adapter: string,
  fetchedAt: string,
): string {
  return composeFrontmatter(
    {
      sourceUrl: doc.sourceUrl,
      title: doc.title,
      author: doc.author,
      publishedAt: doc.publishedAt,
      fetchedAt,
      adapter,
    },
    doc.contentMarkdown,
  )
}

/** Parse a source file back into a Document. Returns null when it carries
 * no `sourceUrl` — either it has no frontmatter, or it lost the field, and
 * anything without it probably wasn't written by us. */
function parseSourceFile(raw: string): ParsedSource | null {
  const { data, body } = splitFrontmatter(raw)
  if (!data.sourceUrl) return null
  return {
    sourceUrl: data.sourceUrl,
    title: data.title ?? '(untitled)',
    contentMarkdown: body.trimEnd(),
    publishedAt: data.publishedAt || undefined,
    author: data.author || undefined,
  }
}

// Currently-unused export kept for future imports that want to inspect
// the source folder directly (e.g. a settings panel showing every
// import the user has done). Avoids tree-shaking the helper out before
// its consumer lands.
export async function listSourceNamespaces(): Promise<string[]> {
  if (!(await vaultFileExists(SOURCES_ROOT))) return []
  const entries = await listVaultDir(SOURCES_ROOT)
  return entries.filter((name) => !name.startsWith('_'))
}
