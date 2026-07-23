// Headless proof of the RISKIEST card-redesign question (research §5.1):
// does the chart widget survive CodeMirror's per-edit widget churn WITHOUT
// remounting (which would flicker the diagram / lose state)?
//
// We don't need the browser or a real mermaid render for this — the guarantee
// lives entirely in the widget's eq() + the field's placement/reveal logic,
// which are testable on a plain EditorState. (MermaidBlock is dynamically
// imported only at toDOM time, so importing this module is light.)

import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { mermaidField, MermaidWidget } from './mermaidCards'

const DOC = [
  '# Title',
  '',
  'Some paragraph above.',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  'Some paragraph below.',
].join('\n')

function stateFor(doc: string, sel?: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: sel === undefined ? undefined : { anchor: sel },
    extensions: [markdown({ extensions: [GFM] }), mermaidField],
  })
  ensureSyntaxTree(state, doc.length, 5000)
  // create() ran before the tree was forced; recompute by applying a no-op
  // selection set so the field rebuilds against the full tree.
  return state.update({ selection: { anchor: state.selection.main.head } }).state
}

function mermaidWidgetIn(set: DecorationSet): MermaidWidget | null {
  let found: MermaidWidget | null = null
  set.between(0, 1e9, (_f, _t, deco) => {
    const w = deco.spec.widget
    if (w instanceof MermaidWidget) {
      found = w
      return false
    }
  })
  return found
}

describe('mermaid card — widget lifecycle (no-remount) proof', () => {
  it('places a block widget for a ```mermaid fence (cursor away)', () => {
    const state = stateFor(DOC, 0) // cursor on line 1, far from the fence
    const w = mermaidWidgetIn(state.field(mermaidField))
    expect(w).not.toBeNull()
    expect(w!.code).toBe('flowchart LR\n  A --> B')
  })

  it('UNRELATED edit keeps an eq() widget → CM reuses DOM (no remount, no flicker)', () => {
    const before = stateFor(DOC, 0)
    const wBefore = mermaidWidgetIn(before.field(mermaidField))!
    // Insert text in the paragraph ABOVE the chart (unrelated to its source).
    const at = before.doc.line(3).from
    const after = before.update({ changes: { from: at, insert: 'XYZ ' } }).state
    const wAfter = mermaidWidgetIn(after.field(mermaidField))!
    // Same source → eq true → CodeMirror reuses the existing widget DOM +
    // React root: the rendered diagram is NOT torn down.
    expect(wBefore.eq(wAfter)).toBe(true)
  })

  it('editing the fence body yields a non-eq widget → in-place updateDOM', () => {
    const before = stateFor(DOC, 0)
    const wBefore = mermaidWidgetIn(before.field(mermaidField))!
    const bodyLine = before.doc.line(7) // '  A --> B'
    const after = before
      .update({ changes: { from: bodyLine.to, insert: ' --> C' } })
      .state
    const wAfter = mermaidWidgetIn(after.field(mermaidField))!
    expect(wBefore.eq(wAfter)).toBe(false)
  })

  it('cursor on a fence line reveals raw source (no widget)', () => {
    const fenceLineStart = DOC.indexOf('```mermaid')
    const state = stateFor(DOC, fenceLineStart + 2)
    expect(mermaidWidgetIn(state.field(mermaidField))).toBeNull()
  })
})
