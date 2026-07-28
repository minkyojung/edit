import { toast } from 'sonner'
import { appendMarkdownToWikiPage } from '@/agent/applyIngest'
import { getActiveSlugFromHash } from '@/lib/viewUrl'

// Insert a chat-rendered diagram into the currently open document as a fenced
// ```mermaid block. The editor's mermaidCards extension then renders it inline;
// on disk it stays plain markdown, so it round-trips through any other editor.
// appendMarkdownToWikiPage routes through the transaction + dirty-flush
// pipeline, updating the live editor when the doc is active.
//
// `lang` used to accept 'artifact' and 'chart' too, for renderers removed in
// 2026-07. Nothing can pass them any more, so the type says what's reachable.
export async function insertVizIntoDoc(
  lang: 'mermaid',
  code: string,
): Promise<void> {
  const slug = getActiveSlugFromHash()
  if (!slug) {
    toast.error('No open document', { description: 'Open a document first' })
    return
  }
  // If the source itself contains a triple-backtick run, widen the fence so it
  // can't close early (the AI is told to avoid this, but be defensive).
  const fence = code.includes('```') ? '````' : '```'
  const body = `${fence}${lang}\n${code.replace(/\s+$/, '')}\n${fence}`
  const ok = await appendMarkdownToWikiPage(slug, body)
  if (ok) toast.success('Inserted into note')
  else toast.error('Could not insert into note')
}
