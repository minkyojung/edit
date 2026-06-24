// Tauri-native file picker for chat attachments.
// Uses plugin-dialog to show an OS-level open dialog and plugin-fs to
// read the selected bytes, then hands back FileAttachment objects ready
// for the PromptInput / runChat pipeline.

import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import type { FileAttachment } from '@/chat/types'

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
}

function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

async function bytesToDataUrl(bytes: Uint8Array, mediaType: string): Promise<string> {
  // Copy into a plain ArrayBuffer to avoid SharedArrayBuffer type mismatch.
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf], { type: mediaType })
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(blob)
  })
}

/** Open the OS file picker and return FileAttachment objects for all
 * selected files. Returns an empty array when the user cancels.
 * Scope is limited to $HOME / $DOWNLOAD / $DOCUMENT / $DESKTOP per
 * capabilities/default.json — files outside those paths will fail silently. */
export async function pickAttachments(): Promise<FileAttachment[]> {
  const result = await open({
    title: 'Attach Files',
    multiple: true,
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'Documents', extensions: ['pdf', 'txt', 'csv', 'html', 'htm', 'md', 'markdown'] },
    ],
  })

  if (!result) return []
  const paths = Array.isArray(result) ? result : [result]

  const settled = await Promise.allSettled(
    paths.map(async (path): Promise<FileAttachment> => {
      const mediaType = mimeFromPath(path)
      const bytes = await readFile(path)
      const dataUrl = await bytesToDataUrl(bytes, mediaType)
      return {
        id: crypto.randomUUID(),
        name: path.split('/').pop() ?? path,
        mediaType,
        dataUrl,
      }
    }),
  )

  return settled
    .filter((r): r is PromiseFulfilledResult<FileAttachment> => r.status === 'fulfilled')
    .map((r) => r.value)
}
