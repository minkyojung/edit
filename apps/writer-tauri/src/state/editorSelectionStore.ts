// Editor-agnostic "what's selected right now". The chat panel reads this to
// render the selection chip and to inject the selected passage as free-chat
// context — without holding any editor reference. The active editor
// (CodeMirror) publishes its live selection here on every selection change,
// and `collapse` lets the chip's X clear that selection back in the editor.
// Empty selection ⇒ selection is null.
import { create } from 'zustand'

export interface EditorSelection {
  /** Full selected text — injected into the chat as context. */
  text: string
  /** 1-based first line of the selection (CM `doc.lineAt(from).number`). */
  fromLine: number
  /** 1-based last line of the selection. Equals fromLine for a single line. */
  toLine: number
}

interface EditorSelectionState {
  selection: EditorSelection | null
  /** Collapse the live selection in whichever editor is mounted. Registered by
   * the editor on mount, cleared on unmount; null when no editor is active. */
  collapse: (() => void) | null
  setSelection: (selection: EditorSelection | null) => void
  setCollapse: (collapse: (() => void) | null) => void
}

export const useEditorSelectionStore = create<EditorSelectionState>((set) => ({
  selection: null,
  collapse: null,
  setSelection: (selection) => set({ selection }),
  setCollapse: (collapse) => set({ collapse }),
}))
