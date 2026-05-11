// Doc title normalization — one entry point that brings every doc
// into the canonical structure the rest of the app assumes:
//
//   Non-daily:  [ h1 (title slot) ][ ...body ]
//                 - Y.Text('title') is empty (body owns the title)
//                 - No duplicate consecutive h1s at the top
//                 - First child is always an h1, even when empty,
//                   so the placeholder plugin has a slot to paint
//
//   Daily:      [ ...body ]
//                 - No date-as-h1 at the top (legacy artefact from
//                   an earlier build that seeded "# YYYY-MM-DD" into
//                   the body markdown)
//                 - Date label is rendered outside the editor from
//                   meta.date — body doesn't carry it
//
// Idempotent via the single `meta.titleNormalizedV2` flag. Earlier
// builds set three separate flags (titleMigratedToH1, titleDedupedV1,
// titleCleanedV1) for each piece of work; those still exist on
// already-migrated docs but are no longer read — V2 supersedes them.
// Running the V2 pass on a previously-V1'd doc is a no-op for the
// already-completed parts (dedup finds nothing, h1 already present,
// etc), so we don't need a migration-of-the-migration step.
//
// Origin: 'doc-init'. Deliberately NOT in the UndoManager's
// trackedOrigins so this system-driven normalization does not
// pollute the user's undo stack (Cmd+Z right after first open would
// otherwise "undo" the migration).

import type { EditorView } from '@milkdown/kit/prose/view'
import * as Y from 'yjs'
import { dbg } from './editorDebug'

interface NormalizeOptions {
  /** Catalog title (knownDoc.title) — used as a fallback source for
   * the body h1 when Y.Text('title') is empty (typical for freshly-
   * created writing docs whose Y.Text was never seeded). Ignored
   * for daily docs. */
  fallbackTitle?: string
  /** Daily doc's date (YYYY-MM-DD). Only consulted when meta.type
   * is 'daily' — used to detect and remove the legacy "# DATE" h1s
   * that earlier builds wrote into the body. */
  date?: string
}

export function normalizeTitleStructure(
  ydoc: Y.Doc,
  view: EditorView,
  options: NormalizeOptions,
): void {
  // Always-run cleanup, OUTSIDE the V2 gate, for the retired custom
  // title-node experiment. Some docs picked up stray <title> Yjs
  // elements during the experiment; those need to be converted back
  // to heading level=1 regardless of whether V2 already ran on this
  // doc. Idempotent — no-op when no title nodes are present.
  scrubStrayTitleNodes(view)

  const meta = ydoc.getMap('meta')
  if (meta.get('titleNormalizedV2')) return

  ydoc.transact(() => {
    const isDaily = meta.get('type') === 'daily'

    if (isDaily) {
      if (options.date) cleanupDailyDateHeading(view, options.date)
    } else {
      dedupConsecutiveLeadingH1s(view)
      ensureFirstChildIsH1(view, ydoc, options.fallbackTitle)
    }

    // Y.Text('title') is no longer the source of truth — clear it so
    // there's exactly one place the title can live (body h1 for
    // writing docs, meta.date for dailies). The Y.Text key itself
    // stays defined on the ydoc; only its content is wiped.
    const ytext = ydoc.getText('title')
    if (ytext.length > 0) ytext.delete(0, ytext.length)

    meta.set('titleNormalizedV2', true)
  }, 'doc-init')
}

// Convert any `title` PM node in the doc into a `heading` (level 1).
// Title nodes only exist as a residue of the retired custom-title
// experiment — once converted, the doc carries no `title` Yjs
// elements anymore, and the surrounding code stays on its happy
// path of "title slot = first h1".
//
// Walks the doc once, collecting positions in reverse so each
// replacement keeps the earlier positions valid. The replacement
// reuses the title node's inline content unchanged, so any text /
// marks the user typed inside survive intact.
function scrubStrayTitleNodes(view: EditorView): void {
  const doc = view.state.doc
  const headingType = view.state.schema.nodes.heading
  if (!headingType) return
  const positions: number[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'title') {
      positions.push(pos)
      return false
    }
    return true
  })
  if (positions.length === 0) return
  dbg('migration', 'scrubStrayTitleNodes', { count: positions.length })
  const tr = view.state.tr
  for (let i = positions.length - 1; i >= 0; i -= 1) {
    const pos = positions[i]
    const node = tr.doc.nodeAt(pos)
    if (!node || node.type.name !== 'title') continue
    const replacement = headingType.create({ level: 1 }, node.content)
    tr.replaceWith(pos, pos + node.nodeSize, replacement)
  }
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

// ── helpers ──────────────────────────────────────────────────────

const UNTITLED_SENTINEL = 'Untitled'

function filterSentinel(text: string): string {
  return text === UNTITLED_SENTINEL ? '' : text
}

function isH1(first: unknown): first is Y.XmlElement {
  if (!(first instanceof Y.XmlElement)) return false
  if (first.nodeName !== 'heading') return false
  // y-prosemirror passes PM attrs through without coercion, so the
  // heading's `level` is the JS number 1, not the string '1'. Cast
  // through unknown and coerce so this check fires for existing h1s
  // (a string-only compare would always miss).
  return Number(first.getAttribute('level') as unknown) === 1
}

function ensureFirstChildIsH1(
  view: EditorView,
  ydoc: Y.Doc,
  fallbackTitle: string | undefined,
): void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  if (isH1(fragment.toArray()[0])) return

  // Pick title text from the legacy Y.Text first, then catalog
  // fallback. Filter the server's 'Untitled' sentinel from both —
  // it's required by proof-server's title-required validator but
  // not real user data; we want the placeholder plugin to paint
  // 'Untitled' as a hint instead of seeding literal text.
  const ytext = ydoc.getText('title')
  const fromYText = filterSentinel(ytext.toString().trim())
  const fromFallback = filterSentinel(fallbackTitle?.trim() ?? '')
  const titleText = fromYText || fromFallback

  // Always insert an h1 — even with no text — so the body's first
  // child is the title slot the placeholder plugin expects. Empty
  // h1 is harmless data (`# ` in markdown).
  const headingType = view.state.schema.nodes.heading
  if (!headingType) return
  const tr = view.state.tr
  const h1 = titleText
    ? headingType.create({ level: 1 }, view.state.schema.text(titleText))
    : headingType.create({ level: 1 })
  tr.insert(0, h1)
  view.dispatch(tr)
}

// Remove h1s at the top of the doc that immediately follow another
// h1 with identical text content. Targets the duplicate-title
// pattern specifically — not a general dedup. Stops at the first
// non-matching block so legitimate content below the title isn't
// touched.
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
  if (dropEnd === 1) return

  let from = first.nodeSize
  let to = from
  for (let i = 1; i < dropEnd; i += 1) {
    to += doc.child(i).nodeSize
  }
  view.dispatch(view.state.tr.delete(from, to))
}

// Daily docs: strip any leading h1 whose text is the daily's date
// or a concatenation of repeats of it (legacy artefact from a
// pre-fix multi-bootstrap race). Stops at the first non-matching
// block so a heading the user intentionally wrote is left alone.
function cleanupDailyDateHeading(view: EditorView, date: string): void {
  const doc = view.state.doc
  let pos = 0
  let endRemovePos = 0
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i)
    if (child.type.name !== 'heading') break
    if (child.attrs.level !== 1) break
    if (!isRepeatedDate(child.textContent, date)) break
    endRemovePos = pos + child.nodeSize
    pos += child.nodeSize
  }
  if (endRemovePos === 0) return
  const tr = view.state.tr.delete(0, endRemovePos)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

function isRepeatedDate(text: string, date: string): boolean {
  if (text.length === 0 || date.length === 0) return false
  if (text.length % date.length !== 0) return false
  const repeats = text.length / date.length
  for (let i = 0; i < repeats; i += 1) {
    if (text.slice(i * date.length, (i + 1) * date.length) !== date) return false
  }
  return true
}

// ── reader API ──────────────────────────────────────────────────

export function readH1TitleFromFragment(fragment: Y.XmlFragment): string {
  const children = fragment.toArray()
  if (children.length === 0) return ''
  const first = children[0]
  if (!isH1(first)) return ''
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
