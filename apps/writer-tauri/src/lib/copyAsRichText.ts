import { markdownToHtml } from './markdownToHtml'
import { embedLocalImages } from './embedLocalImages'

// Copy markdown to the clipboard in BOTH flavors so it survives a paste
// anywhere. Rich editors (Substack, Notion, Google Docs, CodeMirror,
// ProseMirror) read `text/html` and get real formatting — headings,
// bullets, bold, links, tables — instead of raw `##`/`-` source text.
// Plain / markdown-aware targets read `text/plain` and get the source
// unchanged. This is the fix for "copying a note out loses its style".
//
// Returns true on a full rich-text write. If the async clipboard write
// is unavailable (older webview, denied permission), it falls back to
// writing just the markdown source and returns false, so callers can
// tell the difference.
export async function copyAsRichText(markdown: string): Promise<boolean> {
  const md = markdown.trim()
  if (!md) return false

  // Inline vault-local images so they survive the paste; remote images
  // and everything else pass through untouched.
  const html = await embedLocalImages(markdownToHtml(md))
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([md], { type: 'text/plain' }),
      }),
    ])
    return true
  } catch {
    // Rich write unavailable — degrade to the markdown source so the
    // copy is never a silent no-op.
    try {
      await navigator.clipboard.writeText(md)
    } catch {
      // ignore — nothing more we can do
    }
    return false
  }
}
