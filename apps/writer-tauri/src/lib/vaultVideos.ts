// Video storage for the doc editor.
//
// Mirrors `vaultImages.ts` shape so the drop/paste pipeline can branch
// on MIME and call the matching helper without learning two different
// APIs. The only differences:
//
//   - Files land under `videos/` rather than `images/`.
//   - The MIME → extension map covers the common browser-recognised
//     video containers (mp4 / webm / mov / mkv / m4v / ogv).
//
// No content-hash dedupe — same reasoning as images (rename-on-conflict
// preserves the user's intent), and the cost of hashing a multi-MB
// video on every drop would be visible latency for no real gain.

import { readFile } from '@tauri-apps/plugin-fs'
import { sanitizeFilename } from './docPaths'
import { vaultFileExists, writeVaultBinary } from './vault'

const VIDEOS_DIR = 'videos'

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** Pick an extension for video Files that arrive without a usable
 * filename. Covers the containers Safari / WKWebView will play back —
 * we don't try to be exhaustive, just the ones a user actually drops. */
function extFromMime(mime: string): string {
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/webm') return '.webm'
  if (mime === 'video/quicktime') return '.mov'
  if (mime === 'video/x-matroska') return '.mkv'
  if (mime === 'video/x-m4v') return '.m4v'
  if (mime === 'video/ogg') return '.ogv'
  return ''
}

async function writeVideoBytes(
  bytes: Uint8Array,
  originalName: string,
  mimeHint?: string,
): Promise<string> {
  const [rawStem, parsedExt] = splitExt(basename(originalName))
  const ext = parsedExt || (mimeHint ? extFromMime(mimeHint) : '')
  const safeStem = sanitizeFilename(rawStem) || 'video'

  let relPath = `${VIDEOS_DIR}/${safeStem}${ext}`
  let n = 2
  while (await vaultFileExists(relPath)) {
    relPath = `${VIDEOS_DIR}/${safeStem}-${n}${ext}`
    n++
  }

  await writeVaultBinary(relPath, bytes)
  return relPath
}

/** Copy an external video into the vault's `videos/` folder. Used by
 * the file-dialog entry point when one is wired up. */
export async function copyVideoIntoVault(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath)
  return writeVideoBytes(bytes, basename(absolutePath))
}

/** Import a browser-side File (drag-and-drop or clipboard paste) into
 * the vault. Returns the vault-relative path. */
export async function importVideoFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return writeVideoBytes(bytes, file.name, file.type)
}
