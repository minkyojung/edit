// Live label sync between a parent doc and its referenced children.
//
// When a wikilink is inserted, its anchor text is captured at insert
// time. If the child is later renamed via the explicit rename action
// (Step 4: title-input or Command Palette → Rename), the parent's
// body would otherwise show the old name. This hook keeps the parent's
// wikilink anchor text in sync with the child's current
// `knownDocs.title`.
//
// Path C Step 4: source of truth is `knownDocs[child].title` — the
// filename. Body content is irrelevant to wikilink labels. The hook
// re-runs whenever the catalog changes (re-render trigger via the
// knownDocs zustand subscription) so a rename anywhere propagates to
// every parent's body within the same React tick.

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

  useEffect(() => {
    if (!parentView || !parentSlug) return

    // Apply current titles to every wikilink in the parent body. The
    // effect re-runs on every knownDocs change (rename, new doc,
    // archive), which is what makes this Obsidian-style rename
    // propagation work: the moment renameDoc updates knownDocs.title,
    // every open parent's body gets its anchor text rewritten.
    const children = knownDocs.filter(
      (d) =>
        d.parentId === parentSlug &&
        d.type === 'writing' &&
        !d.archivedAt,
    )
    for (const child of children) {
      syncLabel(parentView, child.slug, child.title ?? '')
    }
  }, [parentView, parentSlug, knownDocs])
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
