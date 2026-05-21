// Image storage for the doc editor.
//
// Three entry points the editor uses:
//   - copyImageIntoVault(absolutePath)  ← slash menu / file dialog
//   - importImageFile(file)             ← drag-and-drop / clipboard paste
//
// Both funnel through `writeImageBytes(bytes, name)` so the dedupe
// rule and the `images/` location live in exactly one place.
//
// Why a flat `images/` folder (not per-doc): Obsidian's convention.
// One image lives in one place, the same image can be referenced
// from multiple docs without duplication, and moving the vault root
// keeps every image link intact. Per-doc folders complicate moves
// and cross-references for no obvious gain at our scale.
//
// Filename collisions get a `-2`, `-3`, … suffix the same way
// `profile/sources.ts::dedupeName` handles its post imports. We
// don't deduplicate by content hash because rename-on-conflict
// preserves the user's intent ("I picked Tom.jpg, I expect to see
// Tom.jpg in my vault").

import { readFile } from '@tauri-apps/plugin-fs'
import { sanitizeFilename } from './docPaths'
import { vaultFileExists, writeVaultBinary } from './vault'

const IMAGES_DIR = 'images'

/** Split a path into its trailing component, working with either
 * POSIX `/` or Windows `\` separators. Used to recover the filename
 * from the absolute path the file dialog hands us. */
function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

/** Split a filename into [stem, extension]. Extension keeps the
 * leading dot when present; missing extension returns empty string. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** Pick an extension for clipboard images that arrive without a
 * filename. Browsers expose the MIME type but `File.name` is often
 * just "image.png" — handle the rare case where it's missing. */
function extFromMime(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/png') return '.png'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/svg+xml') return '.svg'
  return ''
}

/** Shared write path: take raw bytes + a hint filename, place them
 * under `images/` with a collision-free name, and return the
 * vault-relative path. */
async function writeImageBytes(
  bytes: Uint8Array,
  originalName: string,
  mimeHint?: string,
): Promise<string> {
  const [rawStem, parsedExt] = splitExt(basename(originalName))
  const ext = parsedExt || (mimeHint ? extFromMime(mimeHint) : '')
  const safeStem = sanitizeFilename(rawStem) || 'image'

  // Dedupe: image.jpg → image-2.jpg → image-3.jpg → …
  let relPath = `${IMAGES_DIR}/${safeStem}${ext}`
  let n = 2
  while (await vaultFileExists(relPath)) {
    relPath = `${IMAGES_DIR}/${safeStem}-${n}${ext}`
    n++
  }

  await writeVaultBinary(relPath, bytes)
  return relPath
}

/** Copy an external image into the vault's `images/` folder and
 * return the vault-relative path the caller should embed in the
 * markdown image src.
 *
 * Caller's responsibility: the absolute source path must already be
 * something the user picked (e.g. via the dialog plugin). We don't
 * validate the file is actually an image — the dialog's extension
 * filter is the gate. A non-image written here would render as a
 * broken image in the doc, no other harm. */
export async function copyImageIntoVault(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath)
  return writeImageBytes(bytes, basename(absolutePath))
}

/** Import a browser-side File (drag-and-drop or clipboard paste)
 * into the vault. Returns the vault-relative path. */
export async function importImageFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return writeImageBytes(bytes, file.name, file.type)
}
