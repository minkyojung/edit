// Single source of the currently-mounted ProseMirror EditorView.
//
// The view used to be App.tsx-local state and was prop-drilled into
// MarkPopoverLayer. Ingest needs the same handle (so it can stamp
// proofSuggestion marks into the active wiki page when applying a
// proposal), and prop-drilling four levels into a sidebar card was
// awkward. This store keeps it as runtime-only data — no persistence,
// no zustand middleware overhead — that any consumer can subscribe to.
//
// Set from MilkdownEditor's onViewReady handler in App.tsx; cleared
// by the same callback when the editor unmounts (key change between
// docs). Reads are by ref via getState() in non-React contexts (the
// ingest apply flow), or via the hook in React components.

import { create } from 'zustand'
import type { EditorView } from '@milkdown/kit/prose/view'

interface EditorViewState {
  /** The view of the currently-active doc, or null when no doc is
   * open or the editor is mid-transition between docs. */
  view: EditorView | null
  setView: (view: EditorView | null) => void
}

export const useEditorViewStore = create<EditorViewState>((set) => ({
  view: null,
  setView: (view) => set({ view }),
}))
