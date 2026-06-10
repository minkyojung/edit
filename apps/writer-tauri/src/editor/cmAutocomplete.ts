// Production autocomplete sources for the CodeMirror editor — the real-data wiring
// behind the prototype's static stubs. The prototype `wikilinkSource` (NOTE_TITLES)
// stays for the dev routes; this version reads real knownDocs and creates notes the
// same way WikilinkPalette does.

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { inCodeBlock } from '@/prototypes/slashCommands'
import { useDocsStore } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'

/** Live, user-facing note titles (archived + system excluded), de-duped
 * case-insensitively (first wins) — the same filter as resolution / broken styling. */
function liveTitles(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of useDocsStore.getState().knownDocs) {
    if (d.archivedAt || d.type.startsWith('system:')) continue
    const title = (d.title ?? '').trim()
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(title)
  }
  return out
}

const insertWikilink = (title: string) => (view: EditorView, _c: Completion, from: number, to: number) => {
  const insert = `[[${title}]]`
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
}

// Create-on-pick: insert the link now, then create the note (fire-and-forget) so it
// resolves to a real doc — once created, the next decoration rebuild styles it live.
// Mirrors WikilinkPalette: a writing nests one-deep under its daily ancestor.
const insertAndCreate = (title: string) => (view: EditorView, c: Completion, from: number, to: number) => {
  insertWikilink(title)(view, c, from, to)
  const store = useDocsStore.getState()
  const active = getActiveSlugFromHash()
  const dailyParent = active ? store.findDailyAncestorSlug(active) : null
  if (dailyParent) void store.createWritingChild(dailyParent, title)
}

/** `[[query` → real note titles + a "Create" option for a non-matching query. */
export function cmWikilinkSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\[\[[^\]\n[]*$/)
  if (!word) return null
  if (inCodeBlock(context.state, context.pos)) return null

  const query = word.text.slice(2) // drop the leading `[[`
  const q = query.trim().toLowerCase()
  const titles = liveTitles()
  const matches = titles.filter((t) => !q || t.toLowerCase().includes(q))

  const options: Completion[] = matches.map((t) => ({ label: t, type: 'variable', apply: insertWikilink(t) }))
  if (q && !titles.some((t) => t.toLowerCase() === q)) {
    options.push({ label: `Create “${query.trim()}”`, type: 'text', apply: insertAndCreate(query.trim()) })
  }

  if (options.length === 0) return null
  return { from: word.from, to: word.to, filter: false, options }
}
