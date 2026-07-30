// Non-markdown vault files ("attachments") — pure helpers shared by the
// sidebar scan, the tree builder, and the in-app file viewer. Kept pure
// (no I/O, no store) so the classification — which gates what surfaces in
// the tree and how the viewer renders — is unit-testable in isolation.

/** App-internal sidecars / transients that live next to notes but aren't
 * user files: doc metadata, mark anchors, the Yjs doc, atomic-write temps. */
const EXCLUDED_SUFFIXES = ['.meta.json', '.marks.json', '.ydoc', '.tmp']

/** True for a vault-relative path the sidebar should show as a read-only
 * attachment row. Excludes markdown (notes have their own rows), anything
 * inside a dot-dir or dot-file (`.git/`, `.DS_Store`), and app sidecars. */
export function isAttachmentFile(rel: string): boolean {
  if (rel.endsWith('.md')) return false
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return false
  if (EXCLUDED_SUFFIXES.some((s) => rel.endsWith(s))) return false
  return true
}

export type AssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'html' | 'other'

/** Extension → how the viewer should render it. Lowercased, extension-only
 * (the webview decides codec support; unknowns degrade to `other` → the
 * "open in default app" fallback). */
const EXT_KIND: Record<string, AssetKind> = {
  // images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', avif: 'image', heic: 'image',
  // documents
  pdf: 'pdf',
  // audio
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', ogg: 'audio',
  // video
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', mkv: 'video',
  // text / code
  txt: 'text', text: 'text', csv: 'text', tsv: 'text', log: 'text', json: 'text',
  yaml: 'text', yml: 'text', xml: 'text', toml: 'text', ini: 'text', markdown: 'text',
  // Rendered, not shown as source: an HTML file here is an artifact the agent
  // wrote to be looked at. Its own kind rather than `text` so the viewer can
  // give it a sandboxed frame — see FileViewer's html branch.
  html: 'html', htm: 'html',
}

/** Classify a filename by extension for the file viewer. */
export function classifyAsset(filename: string): AssetKind {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return 'other'
  return EXT_KIND[filename.slice(dot + 1).toLowerCase()] ?? 'other'
}
