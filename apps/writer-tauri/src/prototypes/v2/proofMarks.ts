// CM-native proof / suggestion mark system (shared). A StateField is the single
// source of truth; decorations are DERIVED (strike old / show new / Keep-Reject);
// StateEffects drive add/accept/reject. Live re-anchoring is EXACT via
// set.map(tr.changes); accept/reject are undoable via invertedEffects. See
// ProofMarkSpike (#/dev/proofmark) for the isolated proof, ProofRichSpike
// (#/dev/proofrich) for it layered over the full markdown live-preview.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import { renderMarkdownReadonly } from './renderMarkdownReadonly'

export type Suggestion = {
  id: string
  from: number
  to: number // range to replace (to > from); for a block INSERTION, to === from
  after: string // suggested markdown — a word, or a whole block (table/image/video…)
  // 'inline' = small text edit, rendered as a green replacement span.
  // 'block'  = the `after` markdown is a whole block; rendered as a real read-only
  //            PREVIEW (same pipeline as the doc) in a block widget. Covers
  //            table/image/video/… with one code path.
  layout: 'inline' | 'block'
  // Optional local file to import into the vault on accept. The doc only ever stores
  // a vault-relative path (portable); the actual copy happens at accept time via the
  // same import path drop/paste uses. (Spike: carried but not yet wired to Tauri.)
  asset?: { srcPath: string }
}

// addSuggestion carries a positioned range, so it MUST provide `map`: when CM stores
// it for undo (invertedEffects) and the doc changes before the undo runs, the range
// has to be mapped through those changes.
export const addSuggestion = StateEffect.define<Suggestion>({
  map: (s, change) => ({ ...s, from: change.mapPos(s.from, 1), to: change.mapPos(s.to, -1) }),
})
export const acceptSuggestion = StateEffect.define<string>() // id
export const rejectSuggestion = StateEffect.define<string>() // id

export const suggestionField = StateField.define<Suggestion[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged && tr.effects.length === 0) return value
    let next = tr.docChanged
      ? value
          .map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) }))
          // Drop a fully-deleted inline range; a block INSERTION is to === from by
          // design, so keep it (its anchor still maps).
          .filter((s) => s.layout === 'block' || s.to > s.from)
      : [...value]
    for (const e of tr.effects) {
      if (e.is(addSuggestion)) next.push(e.value)
      if (e.is(acceptSuggestion) || e.is(rejectSuggestion)) next = next.filter((s) => s.id !== e.value)
    }
    return next
  },
})

function acceptOp(view: EditorView, id: string) {
  const s = view.state.field(suggestionField).find((x) => x.id === id)
  if (!s) return
  // Production: if s.asset is set, first copy the file into the vault (same import
  // path as drop/paste) and rewrite s.after to the vault-relative link before
  // inserting — the doc only ever stores a portable path. (Not wired in the spike.)
  view.dispatch({ changes: { from: s.from, to: s.to, insert: s.after }, effects: acceptSuggestion.of(id) })
}
function rejectOp(view: EditorView, id: string) {
  view.dispatch({ effects: rejectSuggestion.of(id) })
}

type WithPreview = HTMLElement & { _preview?: EditorView }

const proofBtn = (label: string, cls: string, fn: () => void) => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    fn()
  })
  return b
}

class ReviewWidget extends WidgetType {
  constructor(readonly s: Suggestion) {
    super()
  }
  eq(o: ReviewWidget) {
    return o.s.id === this.s.id && o.s.after === this.s.after && o.s.layout === this.s.layout
  }
  toDOM(view: EditorView) {
    return this.s.layout === 'block' ? this.blockDOM(view) : this.inlineDOM(view)
  }
  // Inline: strike-through old text (the cm-proof-old mark) + green replacement here.
  inlineDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-proof-review'
    const ins = document.createElement('span')
    ins.className = 'cm-proof-new'
    ins.textContent = this.s.after
    box.append(
      ins,
      proofBtn('✓', 'cm-proof-keep', () => acceptOp(view, this.s.id)),
      proofBtn('✕', 'cm-proof-reject', () => rejectOp(view, this.s.id)),
    )
    return box
  }
  // Block: render `after` through the REAL renderer (read-only) so the suggested
  // table/image/video previews as itself. One path covers every block type.
  blockDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div') as WithPreview
    box.className = 'cm-proof-block'
    const bar = document.createElement('div')
    bar.className = 'cm-proof-bar'
    const label = document.createElement('span')
    label.className = 'cm-proof-label'
    label.textContent = this.s.to > this.s.from ? 'Suggested replacement' : 'Suggested insertion'
    bar.append(
      label,
      proofBtn('✓ Insert', 'cm-proof-keep', () => acceptOp(view, this.s.id)),
      proofBtn('✕', 'cm-proof-reject', () => rejectOp(view, this.s.id)),
    )
    const preview = document.createElement('div')
    preview.className = 'cm-proof-preview'
    box._preview = renderMarkdownReadonly(preview, this.s.after)
    box.append(bar, preview)
    return box
  }
  // CM does not auto-destroy the nested preview view — release it on teardown.
  destroy(dom: HTMLElement) {
    ;(dom as WithPreview)._preview?.destroy()
  }
  ignoreEvent() {
    return true
  }
}

function buildDecorations(suggestions: Suggestion[]): DecorationSet {
  const ranges = suggestions.flatMap((s) =>
    s.layout === 'block'
      ? // A block widget must sit at a line boundary; the seed anchors s.from there.
        [Decoration.widget({ widget: new ReviewWidget(s), block: true, side: 1 }).range(s.from)]
      : [
          Decoration.mark({ class: 'cm-proof-old' }).range(s.from, s.to),
          Decoration.widget({ widget: new ReviewWidget(s), side: 1 }).range(s.to),
        ],
  )
  return Decoration.set(ranges, true)
}

const proofDecorations = EditorView.decorations.compute([suggestionField], (state) =>
  buildDecorations(state.field(suggestionField)),
)

const proofInvertedEffects = invertedEffects.of((tr) => {
  const inverted: StateEffect<unknown>[] = []
  for (const e of tr.effects) {
    if (e.is(acceptSuggestion) || e.is(rejectSuggestion)) {
      const s = tr.startState.field(suggestionField).find((x) => x.id === e.value)
      if (s) inverted.push(addSuggestion.of(s))
    }
    if (e.is(addSuggestion)) inverted.push(rejectSuggestion.of(e.value.id))
  }
  return inverted
})

const proofTheme = EditorView.theme({
  '.cm-proof-old': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
    borderRadius: '2px',
  },
  '.cm-proof-review': { whiteSpace: 'nowrap' },
  '.cm-proof-new': {
    color: 'var(--foreground)',
    background: 'color-mix(in oklch, #2ecc71 22%, transparent)',
    borderRadius: '2px',
    padding: '0 0.15em',
    marginLeft: '0.15em',
  },
  '.cm-proof-keep, .cm-proof-reject': {
    fontSize: '11px',
    lineHeight: '1',
    padding: '1px 4px',
    marginLeft: '3px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    background: 'var(--background)',
  },
  '.cm-proof-keep': { color: '#2ecc71' },
  '.cm-proof-reject': { color: 'var(--destructive, crimson)' },
  // ── Block suggestion: NO box around the preview ──────────────────────────────
  // The previewed block keeps its own chrome (a table draws its own borders, exactly
  // as it will look in the document); the suggestion is announced by the slim action
  // bar alone. Green lives in exactly one place — the ✓ Insert button.
  '.cm-proof-block': {
    margin: '0.5em 0',
  },
  '.cm-proof-bar': {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 0 6px',
    fontSize: '12px',
    color: 'var(--muted-foreground)',
  },
  '.cm-proof-label': { marginRight: 'auto' },
  // No inner gutter — the preview shows the block exactly as the document would.
  '.cm-proof-preview': { padding: '0' },
})

export const proofMarks: Extension = [suggestionField, proofDecorations, proofInvertedEffects, proofTheme]

/** Build an INLINE replace-suggestion by locating `word` in the doc text (first match). */
export function seedSuggestion(docText: string, word: string, after: string, id: string): Suggestion | null {
  const from = docText.indexOf(word)
  return from < 0 ? null : { id, from, to: from + word.length, after, layout: 'inline' }
}

/** Build a BLOCK insertion-suggestion anchored at `pos` (must be a line boundary).
 * `after` is the block markdown to insert (table / image / video / …). */
export function blockSuggestion(pos: number, after: string, id: string, asset?: { srcPath: string }): Suggestion {
  return { id, from: pos, to: pos, after, layout: 'block', asset }
}
