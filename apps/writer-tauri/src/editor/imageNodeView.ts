// PM NodeView for image nodes. The commonmark preset stores the
// markdown `src` verbatim ('images/foo.jpg' for a vault-relative
// reference, or a full URL when the assistant happens to embed one),
// but Tauri's webview only loads filesystem files through the asset
// protocol. This NodeView is the only place that knows about that
// translation:
//
//   `images/foo.jpg`  →  <vault-root>/images/foo.jpg  →  asset URL
//
// Markdown source stays portable (vim, grep, git, Obsidian all see
// `images/foo.jpg`); the asset URL only materialises in the DOM.
//
// External URLs (`http://`, `https://`, `data:`, `blob:`) are passed
// through unchanged so chat-side assistant-emitted images or future
// pasted URLs keep working. CSP still polices what schemes the
// webview will actually load.
//
// Right-click opens the alt-description dialog. The actual UI lives
// in <ImageAltDialog/> at the app root; the NodeView just records
// the target position in a Zustand store. We use `getPos` (PM's
// third NodeView constructor arg) so the dialog gets the live
// doc position rather than a stale one — getPos always reflects
// where the node sits *now*, even after upstream edits.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useImageAltDialogStore } from '@/state/imageAltDialogStore'

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i

class ImageNodeView {
  readonly dom: HTMLImageElement
  private lastSrc: string | undefined
  private getPos: () => number | undefined

  constructor(node: PMNode, getPos: () => number | undefined) {
    this.getPos = getPos
    this.dom = document.createElement('img')
    this.dom.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.dom.title = String(node.attrs.title)
    this.dom.className =
      'max-w-full h-auto rounded my-2 block'
    this.dom.draggable = false
    this.dom.addEventListener('contextmenu', this.onContextMenu)
    this.dom.addEventListener('dragstart', this.onDragStart)
    this.applySrc(node.attrs.src as string | undefined)
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const pos = this.getPos()
    if (pos == null) return
    useImageAltDialogStore
      .getState()
      .openWith(pos, this.dom.alt, this.dom.getBoundingClientRect())
  }

  /** Own the drag preview so the browser doesn't paint surrounding
   * compositor layers (other editor chrome, popovers, etc.) into
   * the drag image. The default behaviour snapshots the element's
   * full stacking context and on WKWebView that pulls in stray
   * ancestor CSS layers. Calling setDragImage with this img alone
   * scopes the preview to exactly the image and nothing else. */
  private onDragStart = (e: DragEvent): void => {
    if (!e.dataTransfer) return
    const rect = this.dom.getBoundingClientRect()
    // Offset puts the cursor near the top-left of the preview so the
    // user sees where the image will land relative to their pointer.
    // Cap the offset for very large images so the cursor doesn't end
    // up far from the preview's edge.
    const offsetX = Math.min(rect.width / 2, 80)
    const offsetY = Math.min(rect.height / 2, 60)
    e.dataTransfer.setDragImage(this.dom, offsetX, offsetY)
  }

  private applySrc(rawSrc: string | undefined): void {
    if (this.lastSrc === rawSrc) return
    this.lastSrc = rawSrc
    if (!rawSrc) {
      this.dom.removeAttribute('src')
      return
    }
    if (ABSOLUTE_URL_RE.test(rawSrc)) {
      // Already a full URL (http, https, data, blob, ...). Pass through.
      this.dom.src = rawSrc
      return
    }
    // Relative path → resolve against the vault and convert to the
    // asset protocol URL the webview can fetch. Vault might not be
    // selected yet during boot; in that case leave src unset until
    // an update tick arrives with a vault available.
    const vaultPath = getActiveVaultPath()
    if (!vaultPath) {
      this.dom.removeAttribute('src')
      return
    }
    void join(vaultPath, rawSrc)
      .then((abs) => {
        // Guard against the node updating again while we awaited
        // the join — only apply if the src we resolved is still
        // the one we want.
        if (this.lastSrc !== rawSrc) return
        this.dom.src = convertFileSrc(abs)
      })
      .catch((err) => {
        console.warn('[image-node-view] resolve failed', { rawSrc, err })
      })
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'image') return false
    this.dom.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.dom.title = String(node.attrs.title)
    else this.dom.removeAttribute('title')
    this.applySrc(node.attrs.src as string | undefined)
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('contextmenu', this.onContextMenu)
    this.dom.removeEventListener('dragstart', this.onDragStart)
  }
}

export const imageNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node, _view, getPos) => new ImageNodeView(node, getPos),
          imageBlock: (node, _view, getPos) => new ImageNodeView(node, getPos),
        },
      },
    }),
)
