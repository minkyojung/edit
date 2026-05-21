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

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i

class ImageNodeView {
  readonly dom: HTMLImageElement
  private lastSrc: string | undefined

  constructor(node: PMNode) {
    this.dom = document.createElement('img')
    this.dom.alt = (node.attrs.alt as string) ?? ''
    if (node.attrs.title) this.dom.title = String(node.attrs.title)
    this.dom.className =
      'max-w-full h-auto rounded my-2 block'
    this.dom.draggable = false
    this.applySrc(node.attrs.src as string | undefined)
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
}

export const imageNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node) => new ImageNodeView(node),
        },
      },
    }),
)
