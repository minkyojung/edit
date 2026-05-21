// Open/close state for the per-image "edit description" popover.
//
// The image lives inside a ProseMirror NodeView, which is rendered
// outside the React tree — that means we can't wrap the <img> with
// a Radix Popover directly. Instead the NodeView reacts to a
// right-click by writing to this store, and a single
// <ImageAltDialog/> mounted at the app root subscribes and renders
// the popover anchored to the image's bounding rect. One popover
// instance for the whole editor, regardless of how many images the
// doc has.
//
// `pos` is treated as a hint — the popover re-resolves
// `doc.nodeAt(pos)` at save time and bails if the image is gone, so
// concurrent edits (collab, autosave reload) can't write to the
// wrong node.

import { create } from 'zustand'

interface ImageAltDialogState {
  open: boolean
  /** Doc position of the image node when the popover was opened.
   * Always re-checked at save time. */
  pos: number | null
  /** Viewport rect of the image, used as the popover's anchor. */
  rect: DOMRect | null
  /** The alt value the input should preload. */
  initialAlt: string
  openWith: (pos: number, alt: string, rect: DOMRect) => void
  close: () => void
}

export const useImageAltDialogStore = create<ImageAltDialogState>((set) => ({
  open: false,
  pos: null,
  rect: null,
  initialAlt: '',
  openWith: (pos, alt, rect) => set({ open: true, pos, initialAlt: alt, rect }),
  close: () => set({ open: false, pos: null, initialAlt: '', rect: null }),
}))
