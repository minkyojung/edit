// Render ```mermaid fences as live diagrams in CodeMirror by REUSING the
// existing React <MermaidBlock> inside a block-replace widget. Originated as the
// riskiest proof of the card redesign (§5.1 of
// docs/archive/codemirror-cards-redesign-research.md) — can a React viz survive
// CodeMirror's per-edit widget churn without remount/flicker, and stay editable
// via cursor-reveal? — and is now the shipped mermaid renderer.
//
// Key disciplines:
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
import { StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state'
import { cursorInRange } from './v2/cursorRange'

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
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      if (fenceInfo(state, node.from) !== 'mermaid') return
      const lineFrom = state.doc.lineAt(node.from)
      const lineTo = state.doc.lineAt(Math.min(node.to, state.doc.length))
      // Selection touching the fence → show raw source (edit mode). Same
      // edge-inclusive predicate the v2 block layer uses → consistent reveal.
      if (cursorInRange(state, lineFrom.from, lineTo.to)) return
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

/** Could this edit change which mermaid diagrams render? True when a change
 * overlaps an existing (mapped) widget or touches a line with a fence marker
 * (```/~~~) or the word `mermaid` (the info string). Conservative — over-builds
 * rather than risk a stale diagram; when false the mapped set is kept, so typing
 * inside a mermaid body (or anywhere else) never re-walks the whole syntax tree.
 * A revealed fence being edited shows raw source (no widget); the caret leaving it
 * re-renders via the selection branch. Mirrors blocks.ts's `touchesBlocks`. */
function touchesMermaid(tr: Transaction, mapped: DecorationSet): boolean {
  let touched = false
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (touched) return
    mapped.between(fromB, toB, () => {
      touched = true
      return false
    })
    // Scan every line the change spans so a multi-line paste that introduces a
    // ```mermaid fence (marker + info string on separate lines) still rebuilds.
    const first = tr.state.doc.lineAt(fromB).number
    const last = tr.state.doc.lineAt(toB).number
    for (let n = first; n <= last && !touched; n++) {
      const text = tr.state.doc.line(n).text
      if (text.includes('```') || text.includes('~~~') || text.includes('mermaid')) touched = true
    }
  })
  return touched
}

export const mermaidField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => {
    const mapped = value.map(tr.changes)
    // Doc edit: keep the mapped set unless the change could add/remove/alter a
    // mermaid fence — only then re-walk the tree. Stops the per-keystroke scan.
    if (tr.docChanged) return touchesMermaid(tr, mapped) ? build(tr.state) : mapped
    // Caret moved (reveal): positions didn't shift.
    if (tr.selection) return build(tr.state)
    // Parse-progress: the tree advanced (a ```mermaid fence may now be a FencedCode
    // node) — rebuild so it renders as soon as the parser catches up. Cheap pointer
    // compare; only fires on pure parse-progress transactions (after the gates above).
    if (syntaxTree(tr.startState) != syntaxTree(tr.state)) return build(tr.state)
    return mapped
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
})

export const mermaidCards: Extension = mermaidField
