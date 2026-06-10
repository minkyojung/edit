// Suggestion lifecycle — alive / stale / unplaced, plus reload re-anchoring.
//
// A suggestion persists as { quote, after, context } (the markdown body stays clean).
// While the doc is open its range tracks edits EXACTLY via position mapping. On reload
// there is no live position — we re-find the quote and disambiguate by the stored
// structural context (the #/dev/proofanchor win). The policy is precision-or-abstain:
//   • alive    — anchored, and the text under it still equals the quote
//   • stale    — anchored, but the user edited inside it (quote no longer matches) →
//                never auto-applied
//   • unplaced — the quote can't be found (deleted/rewritten), or its range collapsed
//                this session → surfaced in a tray, never silently misplaced
// Reuses resolveAnchors() from anchorResolve.ts for the re-find + structural pick.

import { StateField, StateEffect, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { resolveAnchors } from './anchorResolve'

export type Persisted = { id: string; quote: string; after: string; context: string }
export type LiveSug = Persisted & { from: number; to: number }
export type SugState = 'alive' | 'stale' | 'unplaced'

export const setLiveSugs = StateEffect.define<LiveSug[]>()

export const liveSugField = StateField.define<LiveSug[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged) {
      // Exact live tracking: assoc +1 on `from`, -1 on `to` so edge insertions don't
      // grow the mark; an edit fully inside it adjusts it; a full delete collapses it.
      next = value.map((s) => ({ ...s, from: tr.changes.mapPos(s.from, 1), to: tr.changes.mapPos(s.to, -1) }))
    }
    for (const e of tr.effects) if (e.is(setLiveSugs)) next = e.value
    return next
  },
})

/** The user-visible state of an anchored suggestion, derived live from the doc. */
export function sugState(state: EditorState, s: LiveSug): SugState {
  if (s.to <= s.from) return 'unplaced' // range collapsed — the quoted text is gone
  return state.doc.sliceString(s.from, s.to) === s.quote ? 'alive' : 'stale'
}

// ── reload: re-anchor every persisted suggestion from its quote + context ─────────
export function reanchor(state: EditorState, persisted: Persisted[]): { live: LiveSug[]; unplaced: Persisted[] } {
  const live: LiveSug[] = []
  const unplaced: Persisted[] = []
  for (const p of persisted) {
    const matches = resolveAnchors(state, p.quote)
    let pick = matches.length === 1 ? matches[0] : null
    if (!pick && matches.length > 1) pick = matches.find((m) => m.context === p.context) ?? null // structural disambiguation
    if (pick) live.push({ ...p, from: pick.from, to: pick.to })
    else unplaced.push(p) // not found / still ambiguous → abstain, surface in the tray
  }
  return { live, unplaced }
}

// ── inline rendering (controls live in the side panel, not in the doc) ────────────
class NewTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(o: NewTextWidget) {
    return o.text === this.text
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-sug-new'
    s.textContent = this.text
    return s
  }
  ignoreEvent() {
    return true
  }
}

class StaleBadge extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-sug-stalebadge'
    s.textContent = '원문 바뀜'
    return s
  }
  ignoreEvent() {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const ranges = []
  for (const s of state.field(liveSugField)) {
    const st = sugState(state, s)
    if (st === 'unplaced') continue
    if (st === 'alive') {
      ranges.push(Decoration.mark({ class: 'cm-sug-old' }).range(s.from, s.to))
      ranges.push(Decoration.widget({ widget: new NewTextWidget(s.after), side: 1 }).range(s.to))
    } else {
      ranges.push(Decoration.mark({ class: 'cm-sug-stalemark' }).range(s.from, s.to))
      ranges.push(Decoration.widget({ widget: new StaleBadge(), side: 1 }).range(s.to))
    }
  }
  return Decoration.set(ranges, true)
}

const decorations = EditorView.decorations.compute([liveSugField], build)

const theme = EditorView.theme({
  '.cm-sug-old': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--destructive, crimson) 14%, transparent)',
    borderRadius: '2px',
  },
  '.cm-sug-new': {
    color: 'var(--foreground)',
    background: 'color-mix(in oklch, #2ecc71 22%, transparent)',
    borderRadius: '2px',
    padding: '0 0.15em',
    marginLeft: '0.15em',
  },
  '.cm-sug-stalemark': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
    opacity: '0.5',
  },
  '.cm-sug-stalebadge': {
    marginLeft: '0.3em',
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '0 4px',
    opacity: '0.8',
  },
})

export const anchorLifecycle = [liveSugField, decorations, theme]
