// Editor-agnostic "how big is the open doc right now" — word + character
// counts for the floating stats panel (and the Document info dialog). The
// active editor (CodeMirror) publishes these on every doc change, so any
// surface can read them without holding an editor reference (mirrors
// editorSelectionStore). No doc open ⇒ stats is null.
import { create } from 'zustand'

export interface DocStats {
  /** Whitespace-delimited token count of the document text. */
  words: number
  /** Character count of the document (CM `doc.length`). */
  chars: number
}

interface DocStatsState {
  stats: DocStats | null
  setStats: (stats: DocStats | null) => void
}

export const useDocStatsStore = create<DocStatsState>((set) => ({
  stats: null,
  setStats: (stats) => set({ stats }),
}))

/** Count words + chars from raw document text. Words split on whitespace
 * (covers Korean's space-delimited 어절 and English alike); chars is the
 * raw length so it matches what's actually in the document. */
export function computeDocStats(text: string): DocStats {
  const trimmed = text.trim()
  return {
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
    chars: text.length,
  }
}
