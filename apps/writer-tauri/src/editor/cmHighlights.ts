// CM-native read-it-later highlights — production wiring.
//
// Reuses the proven render core (prototypes/highlights: highlightField +
// the setHighlights effect + offset re-anchor by quote/occurrence) but
// drives it from the REAL source of truth — KnownDoc.highlights via
// lib/highlights. The interactive surface is a single bottom-center
// "highlight bar" (CmHighlightBar) that morphs between states; this module
// holds its state machine + the CM extensions that feed it:
//   1. an initial render extension seeded from the store,
//   2. an effect the CmEditor's store-subscription dispatches to repaint,
//   3. a selection notifier that offers the Highlight prompt,
//   4. a click extension that opens an existing highlight for editing,
//   5. a ⌘⇧M hotkey that highlights the selection, and
//   6. a create helper.
//
// The Milkdown equivalent (useHighlightMarks + highlightClickPlugin) is
// ProseMirror-only; this is its CodeMirror analog.

import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { create } from 'zustand'
import {
  highlights as highlightRender,
  setHighlights,
  occurrenceAt,
} from '@/prototypes/highlights'
import { addHighlightRecord, getHighlights } from '@/lib/highlights'
import { useDocsStore } from '@/state/docsStore'

/** Render extension seeded with the doc's current highlights. Pair it with
 * a store→view sync (see {@link highlightsSyncEffect}) so later edits
 * repaint. */
export function highlightRenderExtension(slug: string): Extension {
  return highlightRender(getHighlights(slug))
}

/** The effect a store subscription dispatches to repaint after a
 * create / remove / note change on `slug`'s highlights. */
export function highlightsSyncEffect(slug: string) {
  return setHighlights.of(getHighlights(slug))
}

// ── Highlight bar state machine ────────────────────────────────────────
// One bottom-center bar, three states:
//   idle    — hidden
//   prompt  — text is selected → offer "Highlight" (+ ⌘⇧M)
//   edit    — a highlight (just-created or clicked) → note input + save
// `isNew` gates the Remove action (nothing to remove on a fresh one) and
// is informational; the first-note→daily mirror is gated separately by the
// record already having a note.
export type HighlightBarState =
  | { kind: 'idle' }
  | { kind: 'prompt'; from: number; to: number }
  | { kind: 'edit'; id: string; isNew: boolean }

interface BarStore {
  state: HighlightBarState
  setState: (s: HighlightBarState) => void
}
export const useCmHighlightBar = create<BarStore>((set) => ({
  state: { kind: 'idle' },
  setState: (state) => set({ state }),
}))

/** Reset the bar to idle (Esc / save / remove). */
export function closeHighlightBar(): void {
  useCmHighlightBar.getState().setState({ kind: 'idle' })
}

/** Selection → prompt. Sticky while editing (a selection change mustn't
 * yank the bar out of note entry); an empty selection clears only a
 * prompt. The bar component gates on the note being a capture, so this
 * stays dumb about doc kind. */
export const highlightSelectionNotifier: Extension =
  EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return
    const cur = useCmHighlightBar.getState().state
    if (cur.kind === 'edit') return // sticky while a note is being typed
    const m = u.state.selection.main
    if (m.empty) {
      if (cur.kind === 'prompt') closeHighlightBar()
      return
    }
    useCmHighlightBar.getState().setState({ kind: 'prompt', from: m.from, to: m.to })
  })

/** Click a painted highlight (`[data-hl-id]`) → open it in the bar for
 * note editing. Leaves the caret to CM's default (return false). */
export const highlightClickExtension: Extension = EditorView.domEventHandlers({
  mousedown(event) {
    const el = (event.target as HTMLElement | null)?.closest('[data-hl-id]')
    if (!el) return false
    const id = el.getAttribute('data-hl-id')
    if (!id) return false
    useCmHighlightBar.getState().setState({ kind: 'edit', id, isNew: false })
    return false
  },
})

/** ⌘⇧M on a captured note with a non-empty selection → create a highlight
 * and open it for an immediate note. No-op otherwise (lets the key fall
 * through). */
export function highlightHotkey(slug: string): Extension {
  return Prec.high(
    keymap.of([
      {
        key: 'Mod-Shift-m',
        run: (view) => {
          const m = view.state.selection.main
          if (m.empty) return false
          const doc = useDocsStore
            .getState()
            .knownDocs.find((d) => d.slug === slug)
          if (!doc?.sourceUrl) return false
          const id = createHighlightFromSelection(view, slug, m.from, m.to)
          if (!id) return false
          useCmHighlightBar.getState().setState({ kind: 'edit', id, isNew: true })
          return true
        },
      },
    ]),
  )
}

/** Record a highlight from a selection range (raw doc offsets) and return
 * its id. The quote is the exact substring so the offset re-anchor
 * (rangeFor) finds it back across reloads; occurrence disambiguates
 * repeated phrases. Returns null for an all-whitespace selection. */
export function createHighlightFromSelection(
  view: EditorView,
  slug: string,
  from: number,
  to: number,
): string | null {
  const quote = view.state.sliceDoc(from, to)
  if (!quote.trim()) return null
  const occurrence = occurrenceAt(view.state.doc.toString(), quote, from)
  const id = crypto.randomUUID()
  addHighlightRecord(slug, {
    id,
    quote,
    occurrence,
    createdAt: new Date().toISOString(),
  })
  return id
}
