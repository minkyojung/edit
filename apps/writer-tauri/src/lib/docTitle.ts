// Read the doc title from the editor body itself — specifically, the
// text of the first level-1 heading in the Y.XmlFragment that backs
// the ProseMirror doc. Used by useDocTitle and the sidebar title
// mirror so every consumer pulls the title from the same logical
// source (the body) rather than the legacy Y.Text('title') side
// channel, which becomes a write-only fallback during the title-fold
// migration and is dropped entirely once every doc has been
// migrated.
//
// Returns '' when there is no first child, the first child is not a
// heading, or the heading is not level 1. Callers fall back to the
// legacy Y.Text in those cases.

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'

/** One-shot migration: move the doc's title from the legacy
 * Y.Text('title') side channel into the editor body's first level-1
 * heading, so every consumer (useDocTitle, sidebar cache, undo,
 * collab) sees the title through the same path as every other piece
 * of editable content.
 *
 * Idempotent via `meta.titleMigratedToH1` — set inside the same Yjs
 * transaction as the migration writes, so a second call (or a
 * concurrent call from another tab of the same client) returns early.
 *
 * Daily docs are skipped: their title is rendered from `meta.date`
 * outside the body, and the existing daily-body H1 cleanup elsewhere
 * in MilkdownEditor handles stray h1s that crept in via earlier bugs.
 *
 * Title source priority: Y.Text > fallback (typically the catalog
 * title from docsStore.knownDocs, mirroring proofClient.createDoc's
 * server-side metadata). Falling back lets freshly-created docs that
 * never seeded their Y.Text pick up their real name on first open.
 *
 * Origin: 'doc-init'. Deliberately NOT in the UndoManager's
 * trackedOrigins so this system-driven move does not pollute the
 * user's undo stack (Cmd+Z right after first open would otherwise
 * "undo" the migration). */
export function migrateTitleToFirstH1(
  ydoc: Y.Doc,
  view: EditorView,
  fallbackTitle: string | undefined,
): void {
  const meta = ydoc.getMap('meta')
  ydoc.transact(() => {
    if (meta.get('type') === 'daily') {
      // Daily: title comes from meta.date; nothing to migrate or dedup.
      // Mark both flags so we don't re-check on every open. The daily
      // body h1 cleanup (cleanupDailyBodyDateHeading) handles its own
      // legacy artefacts.
      meta.set('titleMigratedToH1', true)
      meta.set('titleDedupedV1', true)
      return
    }

    // Main migration — runs once per doc.
    if (!meta.get('titleMigratedToH1')) {
      const fragment = ydoc.getXmlFragment('prosemirror')
      const first = fragment.toArray()[0]
      const alreadyHasH1 =
        first instanceof Y.XmlElement &&
        first.nodeName === 'heading' &&
        // y-prosemirror passes PM attrs through without coercion, so
        // the heading's `level` is the JS number 1, not the string
        // '1'. Cast through unknown and coerce to a number so this
        // check actually fires for existing h1s (an earlier
        // string-only compare always returned false, which is what
        // caused the duplicate-h1 bug this dedup step now cleans up).
        Number(first.getAttribute('level') as unknown) === 1

      const ytext = ydoc.getText('title')

      if (!alreadyHasH1) {
        const fromYText = ytext.toString().trim()
        // 'Untitled' is proof-server's title-required sentinel passed
        // at createDoc time (see docsStore.UNTITLED_SENTINEL) — not
        // user-authored data. Treat it as empty so the new doc's h1
        // starts blank and the placeholder plugin paints 'Untitled'
        // as a hint (vanishes on first keystroke) instead of seeding
        // literal text the user has to delete before typing. Same
        // filter on fallbackTitle for symmetry — knownDoc.title can
        // only hold 'Untitled' via stale cache from earlier builds,
        // but the guard is cheap and prevents the same papercut.
        const fromYTextReal = fromYText === 'Untitled' ? '' : fromYText
        const fromFallback = fallbackTitle?.trim() ?? ''
        const fromFallbackReal = fromFallback === 'Untitled' ? '' : fromFallback
        const titleText = fromYTextReal || fromFallbackReal

        // Always insert the h1 — even with no text — so the body's
        // first child is the title slot the placeholder plugin
        // expects. Without this, brand-new docs (no Y.Text, no
        // fallback) come up with [paragraph(ZWS)] and the title
        // placeholder has nothing to attach to. The empty h1 is
        // harmless data (`# ` in markdown) and lets every consumer
        // rely on the "first child = title" invariant.
        const headingType = view.state.schema.nodes.heading
        if (headingType) {
          const tr = view.state.tr
          const h1 = titleText
            ? headingType.create({ level: 1 }, view.state.schema.text(titleText))
            : headingType.create({ level: 1 })
          tr.insert(0, h1)
          view.dispatch(tr)
        }
      }

      // Y.Text is no longer the source of truth — clear it if non-empty
      // so the h1 path is unambiguously the live data. Reads still
      // fall back to Y.Text in useDocTitle for un-migrated docs, but
      // once migrated, Y.Text stays empty until Stage 5 removes it
      // entirely.
      if (ytext.length > 0) {
        ytext.delete(0, ytext.length)
      }

      meta.set('titleMigratedToH1', true)
    }

    // One-time dedup pass for docs hit by the earlier alreadyHasH1
    // type-compare bug (which caused some docs to grow a second
    // identical h1 at the top). Runs independently of the migration
    // flag so docs that already migrated still get cleaned up. New
    // docs hit this path too but find nothing to remove and just set
    // the flag.
    if (!meta.get('titleDedupedV1')) {
      dedupConsecutiveLeadingH1s(view)
      meta.set('titleDedupedV1', true)
    }
  }, 'doc-init')
}

/** Remove h1s at the top of the doc that immediately follow another
 * h1 with identical text content. Targets the duplicate-title pattern
 * specifically — not a general dedup. Stops at the first non-matching
 * block so legitimate content below the title isn't touched. */
function dedupConsecutiveLeadingH1s(view: EditorView): void {
  const doc = view.state.doc
  if (doc.childCount < 2) return
  const first = doc.child(0)
  if (first.type.name !== 'heading' || first.attrs.level !== 1) return

  let dropEnd = 1
  while (dropEnd < doc.childCount) {
    const next = doc.child(dropEnd)
    if (next.type.name !== 'heading') break
    if (next.attrs.level !== 1) break
    if (next.textContent !== first.textContent) break
    dropEnd += 1
  }
  if (dropEnd === 1) return // no duplicates

  // Compute byte range covering child[1..dropEnd) and delete it.
  let from = first.nodeSize
  let to = from
  for (let i = 1; i < dropEnd; i += 1) {
    to += doc.child(i).nodeSize
  }
  view.dispatch(view.state.tr.delete(from, to))
}

export function readH1TitleFromFragment(fragment: Y.XmlFragment): string {
  const children = fragment.toArray()
  if (children.length === 0) return ''
  const first = children[0]
  if (!(first instanceof Y.XmlElement)) return ''
  if (first.nodeName !== 'heading') return ''
  // y-prosemirror passes PM node attrs through to Yjs without
  // coercion (see y-prosemirror/dist setAttribute call site), so a
  // PM heading created with { level: 1 } lands here as the number 1,
  // not the string '1'. TypeScript's getAttribute signature says
  // string | undefined but the runtime value is whatever was set.
  // Cast through unknown and coerce to a number so a string-typed
  // attr (from a future binding) still works.
  const level = Number(first.getAttribute('level') as unknown)
  if (level !== 1) return ''
  return collectText(first).trim()
}

function collectText(el: Y.XmlElement): string {
  let s = ''
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      s += child.toString()
    } else if (child instanceof Y.XmlElement) {
      s += collectText(child)
    }
  }
  return s
}
