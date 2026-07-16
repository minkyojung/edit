// Image replace widget for the CM Live Preview core. (Lists render as raw markdown
// text — no marker widgets; tables render via v2/editableTable's EditableTableWidget.)

import { WidgetType, type EditorView } from '@codemirror/view'
import { setVaultAssetSrc } from './setAssetSrc'

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM(view: EditorView) {
    const img = document.createElement('img')
    img.className = 'cm-img'
    setVaultAssetSrc(img, this.src) // resolve vault-relative paths to asset:// URLs
    img.alt = this.alt
    img.loading = 'lazy'
    // The image loads asynchronously, so its real height only appears AFTER CM has
    // already measured this line at the placeholder/estimated height. Tell CM to
    // re-measure once it loads so the heightmap matches what's on screen — without
    // this, clicks and up/down-arrow map to the wrong line (stale heightmap). This
    // is the canonical way to handle a widget whose height settles late.
    img.addEventListener('load', () => view.requestMeasure())
    return img
  }
  // Reuse the existing <img> when src changes — re-set in place. Setting src to the
  // same string is a no-op, so unrelated edits never reload the image.
  updateDOM(dom: HTMLElement) {
    const img = dom as HTMLImageElement
    setVaultAssetSrc(img, this.src)
    img.alt = this.alt
    return true
  }
  // TRUE → the editor ignores events from this widget (same as the media card):
  // clicking does nothing, no selection/border. To move the image, reveal the raw
  // `![...]()` source (arrow a caret onto it) and drag that text — like Obsidian.
  ignoreEvent() {
    return true
  }
  get estimatedHeight() {
    return 240
  }
}

// (Removed: TableWidget + renderInline — the read-only table renderer was
// superseded by v2/editableTable's EditableTableWidget and was no longer wired
// anywhere. See git history if a read-only table renderer is needed again.)

