// Structural anchor resolution — the core of the AI-editing thesis.
//
// Production anchors an AI edit by SEARCHING the markdown for `old_string`; if the
// string occurs more than once it gives up ("ambiguous", looseMatch returns null).
// CodeMirror parses the doc into a Lezer syntax tree, so every occurrence carries its
// exact range AND its structural context (heading / table cell / list item / …). That
// lets us (a) disambiguate by structure where text search can't, and (b) hand the
// assistant real structural context to target with — neither of which the current
// quote-search path can do.

import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

export type Anchor = {
  from: number
  to: number
  context: string // human label: 'heading' | 'table cell' | 'list item' | …
  nodeName: string // raw Lezer node name (debug)
  lineNo: number
  lineText: string
}

// Lezer-markdown (+GFM) node name → human label. Order matters only within a node's
// ancestor walk (handled below); this is a flat lookup.
const LABELS: Array<[RegExp | string, string]> = [
  [/^ATXHeading/, 'heading'],
  [/^SetextHeading/, 'heading'],
  ['TableCell', 'table cell'],
  ['TableHeader', 'table header'],
  ['TableRow', 'table row'],
  ['Table', 'table'],
  ['ListItem', 'list item'],
  ['BulletList', 'list'],
  ['OrderedList', 'list'],
  ['Blockquote', 'blockquote'],
  ['FencedCode', 'code block'],
  ['CodeBlock', 'code block'],
  ['CodeText', 'code block'],
  ['Paragraph', 'paragraph'],
]

function labelFor(nodeName: string): string | null {
  for (const [pat, label] of LABELS) {
    if (typeof pat === 'string' ? pat === nodeName : pat.test(nodeName)) return label
  }
  return null
}

/** The nearest MEANINGFUL structural context of a document position. A paragraph that
 * nests inside a list item / blockquote loses to the more specific container, so a
 * match in a bullet reads as 'list item', not 'paragraph'. */
export function structuralContext(state: EditorState, pos: number): { context: string; nodeName: string } {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  let fallback: { context: string; nodeName: string } | null = null
  while (node) {
    const label = labelFor(node.name)
    if (label) {
      if (label !== 'paragraph') return { context: label, nodeName: node.name } // most specific wins
      if (!fallback) fallback = { context: label, nodeName: node.name } // remember, keep climbing
    }
    node = node.parent
  }
  return fallback ?? { context: 'document', nodeName: 'Document' }
}

/** Every literal occurrence of `needle`, each tagged with its structural context. */
export function resolveAnchors(state: EditorState, needle: string): Anchor[] {
  if (!needle) return []
  const text = state.doc.toString()
  const out: Anchor[] = []
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
    const { context, nodeName } = structuralContext(state, i)
    const line = state.doc.lineAt(i)
    out.push({ from: i, to: i + needle.length, context, nodeName, lineNo: line.number, lineText: line.text })
  }
  return out
}

/** Production's matcher, for side-by-side comparison: exact substring, but REFUSE when
 * the string occurs more than once (the looseMatch `ambiguous → null` rule). */
export function naiveMatch(state: EditorState, needle: string): { ok: boolean; reason: string; count: number } {
  if (!needle) return { ok: false, reason: 'empty', count: 0 }
  const text = state.doc.toString()
  let count = 0
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) count++
  if (count === 0) return { ok: false, reason: 'not found', count }
  if (count > 1) return { ok: false, reason: 'ambiguous — refused', count }
  return { ok: true, reason: 'single match', count }
}
