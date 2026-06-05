// Slash menu (`/`) via the CM-native @codemirror/autocomplete (research #2).
// A single CompletionSource replaces the PM trigger plugin + zustand store +
// React popup + capture-phase keyboard hack. Autocomplete itself owns the
// popup, positioning, ↑/↓/Enter/Esc, focus-stays-in-editor, and the
// "replace /query on apply" — we only supply: (a) when to trigger, (b) the
// keyword-filtered item list, (c) each item's text edit.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

interface SlashItem {
  id: string
  label: string
  keywords: string[]
  type: string // CM completion type → default icon
  apply: NonNullable<Completion['apply']>
}

/** Replace the matched `/query` with a line-prefix marker (block transform),
 * caret right after it. `from`..`to` span the `/query` at line start. */
function prefix(marker: string): SlashItem['apply'] {
  return (view: EditorView, _c, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: marker },
      selection: { anchor: from + marker.length },
    })
  }
}

/** Replace `/query` with a whole-line block + place the caret usefully. */
function block(insert: string, caretOffset: number): SlashItem['apply'] {
  return (view: EditorView, _c, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + caretOffset },
    })
  }
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', keywords: ['paragraph', 'plain', 'p'], type: 'text', apply: prefix('') },
  { id: 'h1', label: 'Heading 1', keywords: ['title', 'h1', '#'], type: 'keyword', apply: prefix('# ') },
  { id: 'h2', label: 'Heading 2', keywords: ['subtitle', 'h2', '##'], type: 'keyword', apply: prefix('## ') },
  { id: 'h3', label: 'Heading 3', keywords: ['h3', '###'], type: 'keyword', apply: prefix('### ') },
  { id: 'bullet', label: 'Bullet list', keywords: ['ul', 'unordered', 'list', '-'], type: 'keyword', apply: prefix('- ') },
  { id: 'numbered', label: 'Numbered list', keywords: ['ol', 'ordered', '1.'], type: 'keyword', apply: prefix('1. ') },
  { id: 'todo', label: 'To-do list', keywords: ['todo', 'task', 'check', 'checkbox', '[ ]'], type: 'keyword', apply: prefix('- [ ] ') },
  { id: 'quote', label: 'Quote', keywords: ['blockquote', 'cite', '>'], type: 'keyword', apply: prefix('> ') },
  { id: 'divider', label: 'Divider', keywords: ['hr', 'rule', 'separator', '---'], type: 'keyword', apply: block('---\n', 4) },
  { id: 'code', label: 'Code block', keywords: ['fence', 'pre', '```'], type: 'keyword', apply: block('```\n\n```', 4) },
  { id: 'image', label: 'Image', keywords: ['picture', 'photo', 'img'], type: 'keyword', apply: block('![alt](url)', 2) },
]

/** Items matching the query against label + keywords. Empty query = all. */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter(
    (it) => it.label.toLowerCase().includes(q) || it.keywords.some((k) => k.includes(q)),
  )
}

export function inCodeBlock(state: EditorState, pos: number): boolean {
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  while (n) {
    if (n.name === 'FencedCode' || n.name === 'CodeText' || n.name === 'CodeBlock') return true
    n = n.parent
  }
  return false
}

/** The CompletionSource. Triggers ONLY on `/` at the very start of a line
 * (writing-first; mid-paragraph slashes are noise) and never inside a code
 * block. Returns keyword-filtered items with filter:false (we already
 * filtered). Exported for headless tests. */
export function slashSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\/[\p{L}\p{N}_]*/u)
  if (!word) return null
  const line = context.state.doc.lineAt(context.pos)
  if (word.from !== line.from) return null // only at line start
  if (inCodeBlock(context.state, context.pos)) return null

  const query = word.text.slice(1)
  const items = filterSlashItems(query)
  if (items.length === 0) return null

  return {
    from: word.from,
    to: word.to,
    filter: false, // already keyword-filtered
    options: items.map((it) => ({ label: it.label, type: it.type, apply: it.apply })),
  }
}
