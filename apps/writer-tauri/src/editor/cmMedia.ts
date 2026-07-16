// Production media import for the CodeMirror editor. The prototype mediaDropPaste
// handles classify → callback → insert; this is the callback: the SAME vault importers
// the ProseMirror mediaDropPastePlugin uses, routed by media kind. Returns the
// vault-relative path (`images/foo.png`, `videos/clip.mp4`, …) that the inserted
// markdown references; the asset bytes are already written to the vault by the importer.

import { classifyMedia } from '@/editor/engine/mediaDrop'
import { importImageFile } from '@/lib/vaultImages'
import { importVideoFile } from '@/lib/vaultVideos'
import { importAudioFile } from '@/lib/vaultAudios'

export async function importMediaToVault(file: File): Promise<string> {
  const kind = classifyMedia(file)
  if (kind === 'image') return importImageFile(file)
  if (kind === 'video') return importVideoFile(file)
  if (kind === 'audio') return importAudioFile(file)
  throw new Error(`Unsupported media type: ${file.type}`)
}
