// Inline vault-local images as base64 data URIs for the clipboard.
//
// markdownToHtml turns `![](images/foo.png)` into `<img src="images/foo.png">`,
// but that path only resolves inside the app's vault — pasted into an
// external editor (Substack, Notion, Docs) it's a dangling link and the
// image shows broken. Embedding the actual bytes as a `data:` URI makes
// the HTML self-contained, so the image travels with the copy.
//
// Remote (http/https), `data:` and `blob:` srcs are already portable and
// left untouched. Missing/unreadable files are left as-is (best effort —
// never throws, so a copy never fails because of one bad image).

import { readFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'

// Matches any scheme prefix (http:, https:, data:, blob:, …). A bare
// vault-relative path like `images/foo.png` has no scheme → local.
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i

function mimeFromExt(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return null
  }
}

/** Base64-encode bytes without blowing the call-stack arg limit on large
 * files (spread of a big array into fromCharCode throws). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function vaultImageToDataUri(rawSrc: string): Promise<string | null> {
  const mime = mimeFromExt(rawSrc)
  if (!mime) return null
  const vaultPath = getActiveVaultPath()
  if (!vaultPath) return null
  // Markdown srcs are percent-encoded; the on-disk path is literal.
  let relPath = rawSrc
  try {
    relPath = decodeURI(rawSrc)
  } catch {
    /* malformed escape — fall back to raw */
  }
  try {
    const abs = await join(vaultPath, relPath)
    const bytes = await readFile(abs)
    return `data:${mime};base64,${bytesToBase64(bytes)}`
  } catch {
    return null
  }
}

/** Rewrite vault-local `<img>` srcs to base64 data URIs. Returns the
 * html unchanged (same reference) when there are no local images, so
 * callers can cheaply skip a re-write. */
export async function embedLocalImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const locals = [...doc.querySelectorAll('img')].filter((img) => {
    const src = img.getAttribute('src')
    return src != null && src !== '' && !ABSOLUTE_URL_RE.test(src)
  })
  if (locals.length === 0) return html
  await Promise.all(
    locals.map(async (img) => {
      const dataUri = await vaultImageToDataUri(img.getAttribute('src')!)
      if (dataUri) img.setAttribute('src', dataUri)
    }),
  )
  return doc.body.innerHTML
}
