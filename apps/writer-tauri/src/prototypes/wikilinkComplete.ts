// Wikilink autocomplete (`[[`) — the SAME CM CompletionSource pattern as the
// slash menu (research #3). Replaces the PM wikilinkPalettePlugin + zustand +
// React WikilinkPalette + keyboard hack. Triggers on `[[` anywhere (wikilinks
// are mid-text, unlike the slash menu), lists note titles, and inserts the
// link on pick. Popup/keyboard/focus/position are CM autocomplete's job.
//
// Prototype scope: candidate list is a static stand-in for the real
// docsStore.knownDocs titles; insert form is `[[Title]]` to match the
// prototype's livePreview rendering. (The real migration picks the canonical
// stored form — `[Title](note:slug)` — but the autocomplete pattern is
// identical.)

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { inCodeBlock } from './slashCommands'

// Stand-in for docsStore.knownDocs titles.
const NOTE_TITLES = [
  'Daily Standup',
  'Project Brasilia',
  'Meeting Notes',
  'Roadmap',
  'Design Spec',
]

function insertWikilink(title: string) {
  return (view: EditorView, _c: unknown, from: number, to: number) => {
    const insert = `[[${title}]]`
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    })
  }
}

/** Triggers on `[[query` (query may be empty — opens as soon as the second
 * `[` lands). Not line-restricted (wikilinks are mid-text); skipped in code
 * blocks. Filters titles by substring and offers a "create" option for a
 * non-matching query. Exported for headless tests. */
export function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\[\[[^\]\n[]*$/)
  if (!word) return null
  if (inCodeBlock(context.state, context.pos)) return null

  const query = word.text.slice(2) // drop the leading `[[`
  const q = query.trim().toLowerCase()
  const matches = NOTE_TITLES.filter((t) => !q || t.toLowerCase().includes(q))

  const options = matches.map((t) => ({
    label: t,
    type: 'variable',
    apply: insertWikilink(t),
  }))

  // "Create new note" when the query doesn't exactly match an existing title.
  if (q && !NOTE_TITLES.some((t) => t.toLowerCase() === q)) {
    options.push({
      label: `Create “${query.trim()}”`,
      type: 'text',
      apply: insertWikilink(query.trim()),
    })
  }

  if (options.length === 0) return null
  return { from: word.from, to: word.to, filter: false, options }
}
