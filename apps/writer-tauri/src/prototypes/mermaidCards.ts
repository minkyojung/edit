// Proof spike: render ```mermaid fences as live diagrams in CodeMirror by
// REUSING the existing React <MermaidBlock> inside a block-replace widget.
// This validates the riskiest part of the card redesign (§5.1 of
// docs/codemirror-cards-redesign-research.md): can a React viz survive
// CodeMirror's per-edit widget churn without remount/flicker, and stay
// editable via cursor-reveal?
//
// Key disciplines proved here:
//   - block replace decoration provided from a StateField (not ViewPlugin)
//   - eq() on the fence source → unchanged diagram keeps its DOM + React root
//     across unrelated edits (no remount, no flicker, SVG preserved)
//   - updateDOM() re-renders into the SAME React root when source changes
//   - cursor on the fence lines suppresses the widget → raw source for editing
//   - atomicRanges so the caret skips the rendered block

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { activeLines } from './livePreview'
import { isComposing, compositionEnded } from './imeComposition'

// Stash the React root on the DOM node so updateDOM/destroy can reuse it.
type RootHost = HTMLElement & { _root?: Root }

// MermaidBlock pulls mermaid (d3/dagre/cytoscape) + shiki — load it only when
// a card actually renders (keeps this module light enough to unit-test the
// decoration/lifecycle logic without that graph).
function renderInto(dom: RootHost, code: string): void {
  if (!dom._root) dom._root = createRoot(dom)
  const root = dom._root
  // Reuse the app's real viz component. Lazy import keeps mermaid's heavy
  // graph (d3/dagre/cytoscape) off the initial bundle; first card render is a
  // touch slow while that chunk loads, then it's cached.
  void import('@/viz/MermaidBlock').then(({ MermaidBlock }) => {
    root.render(createElement(MermaidBlock, { code, isStreaming: false, embedded: true }))
  })
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }
  // Identity = the diagram source. Unchanged source → CM reuses this widget's
  // DOM, so the already-rendered SVG (and its React root) is preserved across
  // edits elsewhere in the doc. This is the anti-flicker guarantee.
  eq(other: MermaidWidget) {
    return other.code === this.code
  }
  toDOM() {
    const dom = document.createElement('div') as RootHost
    dom.className = 'cm-mermaid-card'
    renderInto(dom, this.code)
    return dom
  }
  // Source changed → re-render into the EXISTING root instead of remounting.
  updateDOM(dom: HTMLElement) {
    renderInto(dom as RootHost, this.code)
    return true
  }
  destroy(dom: HTMLElement) {
    const host = dom as RootHost
    const root = host._root
    host._root = undefined
    // Async unmount — React forbids unmounting synchronously during render.
    if (root) queueMicrotask(() => root.unmount())
  }
  // Static diagram — no interactive elements (embedded suppresses the button),
  // so let the editor ignore events from inside it.
  ignoreEvent() {
    return true
  }
}

function fenceInfo(state: EditorState, fenceFrom: number): string {
  return state.doc.lineAt(fenceFrom).text.replace(/^(```|~~~)/, '').trim()
}

function fenceBodyCode(state: EditorState, from: number, to: number): string {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(Math.min(to, state.doc.length)).number
  const lines: string[] = []
  for (let n = first + 1; n <= last - 1; n++) lines.push(state.doc.line(n).text)
  return lines.join('\n')
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const active = activeLines(state)
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      if (fenceInfo(state, node.from) !== 'mermaid') return
      const lineFrom = state.doc.lineAt(node.from)
      const lineTo = state.doc.lineAt(Math.min(node.to, state.doc.length))
      // Cursor on any fence line → show raw source (edit mode).
      for (let n = lineFrom.number; n <= lineTo.number; n++) {
        if (active.has(n)) return
      }
      const code = fenceBodyCode(state, node.from, node.to)
      out.push(
        Decoration.replace({
          widget: new MermaidWidget(code),
          block: true,
        }).range(lineFrom.from, lineTo.to),
      )
    },
  })
  return Decoration.set(out, true)
}

export const mermaidField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    if (isComposing(tr.state)) return value
    return tr.docChanged || tr.selection || compositionEnded(tr) ? build(tr.state) : value
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
})

export const mermaidCards: Extension = mermaidField
