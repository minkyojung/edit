// Image storage for the doc editor.
//
// User flow: slash menu "Image" → file picker hands us an absolute
// path on the user's machine. This module owns the next step: read
// those bytes and drop them under `<vault>/images/<safe-name>`,
// then return the vault-relative path the markdown source should
// reference.
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
  const name = basename(absolutePath)
  const [rawStem, ext] = splitExt(name)
  const safeStem = sanitizeFilename(rawStem) || 'image'

  // Dedupe: image.jpg → image-2.jpg → image-3.jpg → …
  let relPath = `${IMAGES_DIR}/${safeStem}${ext}`
  let n = 2
  while (await vaultFileExists(relPath)) {
    relPath = `${IMAGES_DIR}/${safeStem}-${n}${ext}`
    n++
  }

  const bytes = await readFile(absolutePath)
  await writeVaultBinary(relPath, bytes)
  return relPath
}
