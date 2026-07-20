// Which rows a note's properties panel shows, in which order, with which
// value editor. Kept in its own module (not the component file) so
// PropertiesPanel exports only components — that lets React Fast Refresh
// hot-reload the panel without a full page reload.
//
// Row order IS the note's frontmatter key order (effectiveEntries — the
// same union the flush serializes, so screen order = file order by
// construction). Two affordance rows are prepended/appended even when
// their backing field is empty: status+tags at the top (fill-me rows, the
// pre-panel behavior) and readAt for captured articles.

import type { KnownDoc } from '@/state/docsStore'
import {
  effectiveEntries,
  HIDDEN_PROPERTY_KEYS,
  TYPED_KEY_TO_META,
} from '@/lib/docProperties'

/** How a row's value cell renders/edits. Typed keys keep their dedicated
 * controls; custom keys pick by VALUE SHAPE — a deterministic rule, not
 * an inference model: list → tag-style chips, 'true'/'false' → switch,
 * anything else → borderless text input. */
export type RowEditor = 'status' | 'tags' | 'switch' | 'source' | 'list' | 'text'

export interface PanelRow {
  key: string
  value: string | string[]
  editor: RowEditor
  /** True for rows whose key the app manages (dedicated control + value
   * lives in a typed catalog field). Custom rows edit through fm. */
  typed: boolean
}

function editorFor(key: string, value: string | string[]): RowEditor {
  if (key === 'status') return 'status'
  if (key === 'tags') return 'tags'
  if (key === 'source') return 'source'
  if (key === 'readAt') return 'switch'
  if (Array.isArray(value)) return 'list'
  if (value === 'true' || value === 'false') return 'switch'
  return 'text'
}

/** The panel's row list for a doc. Order = effectiveEntries (leading
 * status/tags, then file key order); readAt appends for captured
 * articles so an unread one still shows the toggle. */
export function panelRows(
  known: Pick<KnownDoc, 'fm' | 'status' | 'tags' | 'createdAt' | 'sourceUrl' |
    'siteName' | 'faviconUrl' | 'savedAt' | 'readAt' | 'videoId' |
    'durationSec' | 'thumbnailUrl' | 'description'>,
): PanelRow[] {
  const rows: PanelRow[] = effectiveEntries(known.fm, known)
    .filter((e) => !HIDDEN_PROPERTY_KEYS.includes(e.key))
    .map((e) => ({
      key: e.key,
      value: e.value,
      editor: editorFor(e.key, e.value),
      typed: e.key in TYPED_KEY_TO_META,
    }))
  // readAt is a bottom affordance for captured articles (effectiveEntries
  // only emits it once it has a value, so an unread article needs the
  // toggle added here).
  if (known.sourceUrl && !rows.some((r) => r.key === 'readAt')) {
    rows.push({ key: 'readAt', value: '', editor: 'switch', typed: true })
  }
  return rows
}
