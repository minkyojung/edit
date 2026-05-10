// Live label sync between a parent doc and its referenced children.
//
// When a wikilink is inserted, its anchor text is captured at insert
// time. If the user later renames the child, the parent's body
// would otherwise show a stale label — the slug still resolves so
// clicks work, but the visible text is wrong.
//
// This module provides a React hook that, while the parent's editor
// view is mounted, subscribes to each warm child's Y.Text('title')
// and rewrites the matching wikilink text in the parent body
// whenever it changes. Updates flow through a single PM transaction
// so collab sees one cohesive change.

import { useEffect } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark } from '@milkdown/kit/prose/model'
import { useDocsStore } from '@/state/docsStore'
import {
  WIKILINK_HREF_PREFIX,
  isWikilinkHref,
} from './wikilinkPalettePlugin'

export function useWikilinkTitleSync(
  parentView: EditorView | null,
  parentSlug: string | null,
): void {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const handles = useDocsStore((s) => s.handles)

  useEffect(() => {
    if (!parentView || !parentSlug) return

    // Only watch children of the active parent. Other docs' titles
    // can change too but they don't affect this body.
    const children = knownDocs.filter(
      (d) =>
        d.parentId === parentSlug &&
        d.type === 'writing' &&
        !d.archivedAt,
    )

    const cleanups: Array<() => void> = []

    for (const child of children) {
      const handle = handles[child.slug]
      if (!handle) continue
      const ytext = handle.ydoc.getText('title')

      // Run once on mount in case the title was changed while this
      // parent wasn't open — the body might already be stale when
      // the user comes back to it.
      syncLabel(parentView, child.slug, ytext.toString())

      const onChange = () => {
        if (!parentView) return
        syncLabel(parentView, child.slug, ytext.toString())
      }
      ytext.observe(onChange)
      cleanups.push(() => ytext.unobserve(onChange))
    }

    return () => {
      for (const fn of cleanups) fn()
    }
  }, [parentView, parentSlug, knownDocs, handles])
}

/** Walk the parent doc, find every link mark whose href is
 * `note:{slug}`, and rewrite its anchor text to `nextLabel` when it
 * differs. Replacements run in reverse-position order so earlier
 * `from`s stay valid as later text nodes shrink/grow. */
function syncLabel(view: EditorView, slug: string, nextLabel: string): void {
  const targetHref = WIKILINK_HREF_PREFIX + slug
  const display = nextLabel || 'Untitled'
  const targets: Array<{ from: number; to: number; mark: Mark }> = []

  view.state.doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') continue
      const href = mark.attrs.href as string | undefined
      if (!isWikilinkHref(href) || href !== targetHref) continue
      if (node.text === display) continue
      targets.push({ from: pos, to: pos + node.nodeSize, mark })
    }
  })

  if (targets.length === 0) return

  const tr = view.state.tr
  for (const t of [...targets].reverse()) {
    const newText = view.state.schema.text(display, [t.mark])
    tr.replaceWith(t.from, t.to, newText)
  }
  // Don't add this rewrite to the undo history — it's a sync
  // correction, not a user-initiated edit.
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}
