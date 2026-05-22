// Source-text extraction for the ingest pipeline. Two layers:
//
//   readDocMarkdown(slug)   — preferred: Milkdown serializer over the
//                             live PM doc (markdown structure preserved).
//   extractFragmentText(fr) — fallback for non-active docs: flat text
//                             walk over the Y.XmlFragment.
//
// Plus a small date helper kept here because it's only used by the
// ingest user-prompt path; not worth a module of its own.

import { isEffectivelyEmpty } from '@/lib/markdownText'
import { useDocsStore } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { useEditorViewStore } from '@/state/editorViewStore'

/** Read a doc's markdown body directly from the client side.
 *
 * Phase 3.A — replaced the previous proof-server round-trip. The
 * server's deriveMarkdownFromFragment crashes on our client's
 * Y.XmlFragment (`node.children.some` on a node without children),
 * so the server's `markdown` column stays empty no matter how much
 * the user types — and ingest was bailing on "source doc empty"
 * even for full daily notes.
 *
 * Strategy:
 *   - Active doc: use the live PM doc + Milkdown's serializer. The
 *     output is the same markdown Milkdown would round-trip back
 *     through its own parser, so the LLM sees the exact text the
 *     user authored (headings, lists, code, etc.).
 *   - Non-active doc: fall back to flat text from the Y.XmlFragment.
 *     This drops markdown structure (#-headings, bullet markers),
 *     but daily notes — the only kind ingest reads — are mostly
 *     prose, so the LLM still extracts entities/bullets fine.
 *     If we later need full markdown for non-active sources, we'd
 *     stand up an offscreen PM instance against the Y.Doc.
 *
 * Returns '' for missing handles or empty/whitespace-only content
 * so a single ingest never crashes — the caller decides whether
 * empty input is worth running on. */
export function readDocMarkdown(slug: string): string {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return ''

  if (getActiveSlugFromHash() === slug) {
    const view = useEditorViewStore.getState().view
    const serializer = useEditorViewStore.getState().serializer
    if (view && serializer) {
      try {
        const md = serializer(view.state.doc).trim()
        if (isEffectivelyEmpty(md)) return ''
        return md
      } catch {
        // fall through to Y.Doc text fallback
      }
    }
  }

  const text = extractFragmentText(handle.ydoc.getXmlFragment('prosemirror'))
  const trimmed = text.trim()
  if (isEffectivelyEmpty(trimmed)) return ''
  return trimmed
}

/** Walk a Y.XmlFragment and collect text content as a flat string.
 * Used by readDocMarkdown's non-active-doc fallback. Markdown
 * structure is lost; for our daily-note workflow that's acceptable
 * (notes are mostly prose). */
export function extractFragmentText(fragment: import('yjs').XmlFragment): string {
  const parts: string[] = []
  function walk(node: import('yjs').XmlElement | import('yjs').XmlText | import('yjs').XmlFragment | import('yjs').XmlHook): void {
    if ('toString' in node && typeof (node as { toString: () => string }).toString === 'function') {
      // XmlText 의 toString 은 자체 텍스트만. XmlElement/Fragment 은 자식
      // 트리 전체. 우리는 자식들의 텍스트만 합치고 싶으므로 element 는
      // 직접 순회.
    }
    const length = (node as { length?: number }).length
    if (typeof length !== 'number') return
    for (let i = 0; i < length; i++) {
      const child = (node as unknown as { get: (i: number) => unknown }).get(i)
      if (!child) continue
      if (typeof (child as { toString: () => string }).toString === 'function') {
        const text = String(child)
        // XmlElement 가 toString 호출 시 자식 합쳐서 반환하면 단락 사이에
        // 줄바꿈이 없음. paragraph 단위로 newline 삽입해야 LLM 이 단락
        // 구분 인식. 단순화: 모든 element 사이에 \n.
        parts.push(text)
        parts.push('\n')
      }
    }
    void walk
  }
  walk(fragment)
  return parts.join('')
}

/** Local-time YYYY-MM-DD. Pinned to local because "today's note"
 * follows the user's wall clock, not UTC. */
export function todayLocalDate(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
