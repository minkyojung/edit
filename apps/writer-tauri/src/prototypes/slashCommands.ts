// Slash menu (`/`) logic — the trigger-word items, keyword filter, code-block
// guard, and each item's text edit. Pure/CM-agnostic on purpose: the rendering
// + open/close state live in `src/editor/slashMenu.tsx` (a StateField + our own
// React tooltip), so this file stays a small, testable logic module.

import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  detail?: string // right-aligned markdown hint (#, ##, - …)
  apply: (view: EditorView, from: number, to: number) => void
}

/** Replace the matched `/query` (from..to) with a line-prefix marker (block
 * transform), caret right after it. */
function prefix(marker: string): SlashItem['apply'] {
  return (view, from, to) => {
    view.dispatch({
      changes: { from, to, insert: marker },
      selection: { anchor: from + marker.length },
    })
  }
}

/** Replace `/query` with a whole-line block + place the caret usefully. */
function block(insert: string, caretOffset: number): SlashItem['apply'] {
  return (view, from, to) => {
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + caretOffset },
    })
  }
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', keywords: ['paragraph', 'plain', 'p'], apply: prefix('') },
  { id: 'h1', label: 'Heading 1', keywords: ['title', 'h1', '#'], detail: '#', apply: prefix('# ') },
  { id: 'h2', label: 'Heading 2', keywords: ['subtitle', 'h2', '##'], detail: '##', apply: prefix('## ') },
  { id: 'h3', label: 'Heading 3', keywords: ['h3', '###'], detail: '###', apply: prefix('### ') },
  { id: 'bullet', label: 'Bullet list', keywords: ['ul', 'unordered', 'list', '-'], detail: '-', apply: prefix('- ') },
  { id: 'numbered', label: 'Numbered list', keywords: ['ol', 'ordered', '1.'], detail: '1.', apply: prefix('1. ') },
  { id: 'todo', label: 'To-do list', keywords: ['todo', 'task', 'check', 'checkbox', '[ ]'], detail: '[ ]', apply: prefix('- [ ] ') },
  { id: 'quote', label: 'Quote', keywords: ['blockquote', 'cite', '>'], detail: '>', apply: prefix('> ') },
  { id: 'divider', label: 'Divider', keywords: ['hr', 'rule', 'separator', '---'], detail: '---', apply: block('---\n', 4) },
  { id: 'code', label: 'Code block', keywords: ['fence', 'pre', '```'], detail: '```', apply: block('```\n\n```', 4) },
  { id: 'image', label: 'Image', keywords: ['picture', 'photo', 'img'], detail: '![]', apply: block('![alt](url)', 2) },
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
