import { toast } from 'sonner'
import { appendMarkdownToWikiPage } from '@/agent/applyIngest'
import { getActiveSlugFromHash } from '@/lib/viewUrl'

// Insert a chat-rendered visualization into the currently open document as a
// fenced code block. The editor's CodeBlockVizNodeView then renders it inline;
// on disk it's plain markdown (```mermaid / ```artifact / ```chart), so it
// round-trips. A ```chart block also gets a stable vizId stamped by vizIdPlugin
// on insert, so it's immediately editable via chat. appendMarkdownToWikiPage
// routes through the PM-transaction + dirty-flush pipeline (no Yjs), updating
// the live editor when the doc is active.
export async function insertVizIntoDoc(
  lang: 'mermaid' | 'artifact' | 'chart',
  code: string,
): Promise<void> {
  const slug = getActiveSlugFromHash()
  if (!slug) {
    toast.error('열린 문서가 없습니다', { description: '먼저 문서를 여세요' })
    return
  }
  // If the source itself contains a triple-backtick run, widen the fence so it
  // can't close early (the AI is told to avoid this, but be defensive).
  const fence = code.includes('```') ? '````' : '```'
  const body = `${fence}${lang}\n${code.replace(/\s+$/, '')}\n${fence}`
  const ok = await appendMarkdownToWikiPage(slug, body)
  if (ok) toast.success('본문에 삽입됨')
  else toast.error('본문에 삽입하지 못했습니다')
}
