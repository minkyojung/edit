// Renders the note's title + properties (PageHeader) as a BLOCK WIDGET at the very
// top of the document, INSIDE CodeMirror's own scroller — so the title/frontmatter
// scroll away with the body (Obsidian's inline-title pattern) instead of sitting in a
// fixed band above the editor.
//
// Disciplines (mirrors mermaidCards / youtubeCards, the proven card pattern):
//   - block widget provided from a StateField (CM6 forbids block widgets from a
//     ViewPlugin)
//   - eq() keyed on the slug → the widget's DOM + React root are reused across every
//     doc edit, so the header never remounts or flickers and its own store
//     subscriptions keep it current
//   - the PageHeader React subtree is mounted into the widget DOM via its own root.
//     Its stores are module singletons and its Radix status dropdown portals to
//     <body>, so a separate root is safe — no cross-root React context is required.

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField } from '@codemirror/state'
import { PageHeader } from '@/layout/PageHeader'

// Stash the React root on the DOM node so destroy() can unmount it (as in mermaidCards).
type RootHost = HTMLElement & { _root?: Root }

class PageHeaderWidget extends WidgetType {
  constructor(readonly slug: string) {
    super()
  }
  // Identity = slug. It's constant for an editor's lifetime, so CM reuses this DOM +
  // React root across every doc edit — the header never remounts.
  eq(other: PageHeaderWidget) {
    return other.slug === this.slug
  }
  toDOM() {
    const dom = document.createElement('div') as RootHost
    dom.className = 'cm-page-header'
    // flow-root establishes a BFC so the header's inner margins (e.g. the title's
    // mb-6) are CONTAINED in this box. CM measures a block widget's height from its
    // bounding box, which EXCLUDES margin — without this the heightmap under-counts
    // and the first body line overlaps the header (the trap documented in cmTheme.ts).
    dom.style.display = 'flow-root'
    if (!dom._root) dom._root = createRoot(dom)
    dom._root.render(createElement(PageHeader, { slug: this.slug }))
    return dom
  }
  destroy(dom: HTMLElement) {
    const host = dom as RootHost
    const root = host._root
    host._root = undefined
    // React forbids unmounting synchronously during a render/commit — defer.
    if (root) queueMicrotask(() => root.unmount())
  }
  // Interactive widget (title input, status dropdown): let the inner React tree own
  // its events. Focus lives in the <input>, not in .cm-content, so CM's keymaps don't
  // fire; returning true keeps CM from treating clicks/keys here as editor input.
  ignoreEvent() {
    return true
  }
}

/** Block widget pinned to document position 0 (side -1 → before the first line). The
 * decoration set is mapped through edits so it stays at the very top as the user
 * types. slug is fixed per editor mount (CmEditor re-mounts on doc switch). */
export function pageHeaderWidget(slug: string): StateField<DecorationSet> {
  const deco = Decoration.set(
    Decoration.widget({ widget: new PageHeaderWidget(slug), block: true, side: -1 }).range(0),
  )
  return StateField.define<DecorationSet>({
    create: () => deco,
    update: (value, tr) => value.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f),
  })
}
