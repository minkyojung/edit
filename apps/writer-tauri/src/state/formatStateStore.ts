// Snapshot of the active block type + active inline marks at the
// current selection. Pushed by formatStatePlugin on every editor
// transaction; subscribed by FormatToolbar to render its toggle/label
// state.
//
// We keep the store minimal — no actions — because the plugin is the
// only writer. React components only read.

import { create } from 'zustand'

/** Identifier for the block the cursor sits in. Headings carry their
 * level so the Style dropdown can render "Heading 2" precisely. */
export type FormatBlockType =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'bullet_list'
  | 'ordered_list'
  | 'blockquote'
  | 'code_block'
  | 'unknown'

interface FormatState {
  blockType: FormatBlockType
  /** Names of inline marks active at the cursor (or covering the
   * full range when the selection is non-empty). For an empty
   * selection this includes storedMarks plus marks immediately
   * adjacent to the cursor — matches Notion / Linear behavior where
   * Bold stays "on" between bold words. */
  activeMarks: Set<string>
}

export const useFormatStateStore = create<FormatState>(() => ({
  blockType: 'paragraph',
  activeMarks: new Set(),
}))
