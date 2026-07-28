// Audio storage for the doc editor.
//
// Mirrors vaultImages / vaultVideos in shape so the drop/paste
// pipeline can branch on MIME and call the matching helper without
// learning three different APIs. Only differences:
//
//   - Files land under `audio/` rather than `images/` / `videos/`.
//   - The MIME → extension map covers the containers that Safari /
//     WKWebView will play back (mp3, wav, m4a, aac, ogg/opus, flac).
//
// No content-hash dedupe — same reasoning as the sibling vault
// helpers: rename-on-conflict preserves the user's intent, and
// hashing a multi-MB audio file on every drop is wasted latency for
// a check that almost never fires.

import { sanitizeFilename } from './docPaths'
import { vaultFileExists, writeVaultBinary } from './vault'

const AUDIO_DIR = 'audio'

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** Pick an extension for audio Files that arrive without a usable
 * filename. Covers the containers Safari / WKWebView decodes — not
 * exhaustive, just the ones a user actually drops. */
function extFromMime(mime: string): string {
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return '.mp3'
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return '.wav'
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return '.m4a'
  if (mime === 'audio/aac') return '.aac'
  if (mime === 'audio/ogg' || mime === 'audio/opus') return '.ogg'
  if (mime === 'audio/flac' || mime === 'audio/x-flac') return '.flac'
  return ''
}

async function writeAudioBytes(
  bytes: Uint8Array,
  originalName: string,
  mimeHint?: string,
): Promise<string> {
  const [rawStem, parsedExt] = splitExt(basename(originalName))
  const ext = parsedExt || (mimeHint ? extFromMime(mimeHint) : '')
  const safeStem = sanitizeFilename(rawStem) || 'audio'

  let relPath = `${AUDIO_DIR}/${safeStem}${ext}`
  let n = 2
  while (await vaultFileExists(relPath)) {
    relPath = `${AUDIO_DIR}/${safeStem}-${n}${ext}`
    n++
  }

  await writeVaultBinary(relPath, bytes)
  return relPath
}

/** Import a browser-side File (drag-and-drop or clipboard paste) into
 * the vault. Returns the vault-relative path. */
export async function importAudioFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return writeAudioBytes(bytes, file.name, file.type)
}
