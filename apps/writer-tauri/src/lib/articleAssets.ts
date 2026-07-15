// Offline asset capture for read-it-later articles. Downloads the
// article's images into the vault and rewrites the Markdown image links
// to local paths, so a saved article reads fully offline (and survives
// the source site removing its images).
//
// Scope (MVP): images only. Other attachments (PDF, etc.) and remote
// media embeds are left as remote links.
//
// Storage: images/<slug>/<contentHash>.<ext> — the same top-level
// `images/` folder the editor drops pasted media into, so a saved
// article doesn't spawn a separate `articles/` tree. The per-article
// <slug> subfolder keeps an article's assets grouped (and cleanable)
// together; content-hash filenames dedupe identical images and keep
// names stable across re-saves.
//
// Robustness: every download is best-effort. A failed image keeps its
// original remote URL — saving an article never fails because an asset
// couldn't be fetched.

import { invoke } from '@tauri-apps/api/core'
import { writeVaultBinary, vaultFileExists } from '@/lib/vault'

interface FetchedBinary {
  url: string
  status: number
  content_type: string | null
  base64: string
}

// Cap downloads per article so a pathological page can't fan out into
// hundreds of requests / writes.
const MAX_ASSETS_PER_ARTICLE = 40

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
}

/** Decide the on-disk extension from the response Content-Type (source
 * of truth), falling back to the URL's extension. Returns null when the
 * response isn't an image — those are skipped (e.g. a tracking pixel
 * that returns HTML, or a non-image link the regex caught). */
function imageExt(contentType: string | null, url: string): string | null {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (mime) {
    if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
    if (mime.startsWith('image/')) {
      // Unknown image subtype (e.g. image/heic): use the subtype.
      const sub = mime.slice('image/'.length).replace(/[^a-z0-9]/g, '')
      return sub || null
    }
    return null // explicitly non-image content type → skip
  }
  // No content type: fall back to a recognizable URL extension.
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)
  if (!m) return null
  const e = m[1].toLowerCase()
  if (e === 'jpeg') return 'jpg'
  return Object.values(EXT_BY_MIME).includes(e) ? e : null
}

/** Collect unique http(s) image URLs from a Markdown body. Parses the
 * `![alt](url "title")` form and takes the URL token only. */
function extractImageUrls(markdown: string): string[] {
  const urls = new Set<string>()
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = m[1].trim().split(/\s+/)[0].replace(/^<|>$/g, '')
    if (/^https?:\/\//i.test(url)) urls.add(url)
  }
  return [...urls]
}

// Uint8Array<ArrayBuffer> (not the default ArrayBufferLike) so the bytes
// satisfy BufferSource for crypto.subtle.digest under strict lib types.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 16)
}

/** Rewrite Markdown image links whose URL is in `map` to the local
 * vault-relative path, preserving alt text and any title. Non-mapped
 * images (downloads that failed / non-images) are left untouched. */
function rewriteImageLinks(markdown: string, map: Map<string, string>): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()([^)]+)(\))/g,
    (full, pre: string, inside: string, post: string) => {
      const parts = inside.trim().split(/\s+/)
      const url = parts[0].replace(/^<|>$/g, '')
      const rel = map.get(url)
      if (!rel) return full
      const title = parts.slice(1).join(' ')
      return `${pre}${rel}${title ? ` ${title}` : ''}${post}`
    },
  )
}

/** Download an article's images into images/<slug>/ and return
 * the Markdown with image links rewritten to the local copies. Returns
 * the input unchanged when there's nothing to localize. Best-effort:
 * failed images keep their remote URL.
 *
 * `referer` (the article's source URL) is sent on each request so CDNs
 * that hotlink-block requests without a Referer still serve the image. */
export async function localizeArticleImages(
  slug: string,
  markdown: string,
  referer?: string,
): Promise<string> {
  const urls = extractImageUrls(markdown).slice(0, MAX_ASSETS_PER_ARTICLE)
  if (urls.length === 0) return markdown

  const dir = `images/${slug}`
  const map = new Map<string, string>()

  for (const url of urls) {
    try {
      const res = await invoke<FetchedBinary>('fetch_binary', { url, referer })
      if (res.status >= 400) continue
      const ext = imageExt(res.content_type, url)
      if (!ext) continue
      const bytes = base64ToBytes(res.base64)
      const relPath = `${dir}/${await contentHash(bytes)}.${ext}`
      if (!(await vaultFileExists(relPath))) {
        await writeVaultBinary(relPath, bytes)
      }
      map.set(url, relPath)
    } catch (err) {
      // Leave the remote URL in place (fallback). Saving must not fail
      // because one image couldn't be fetched.
      console.warn('[readlater] asset download failed', url, err)
    }
  }

  if (map.size === 0) return markdown
  return rewriteImageLinks(markdown, map)
}
