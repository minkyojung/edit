// Source-text extraction for the ingest pipeline.
//
//   readDocMarkdown(slug)   — preferred: Milkdown serializer over the
//                             live PM doc (markdown structure preserved).
//   Non-active doc fallback — `handle.bodyMarkdown` cache (Phase 5a
//                             of the Yjs-removal migration). Read
//                             from disk at handle build time;
//                             refreshed on every seed/replace/reload.
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

  // Phase 5a of the Yjs-removal migration: the inactive-doc fallback
  // reads `handle.bodyMarkdown` instead of walking the Y.Doc fragment
  // for text. The cache is populated by `buildHandle` at load time
  // and refreshed by `seedDocBody` / `replaceDocBody` /
  // `reloadFromVault` whenever the body is rewritten. Real markdown
  // structure (headings, lists, code) survives, where the previous
  // `extractFragmentText` path collapsed everything to flat text.
  const trimmed = handle.bodyMarkdown.trim()
  if (isEffectivelyEmpty(trimmed)) return ''
  return trimmed
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
