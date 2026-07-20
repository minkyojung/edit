// Doc properties — the ordered full-frontmatter model behind the
// Notion-style properties panel. A note's `fm` is the in-memory mirror of
// its on-disk YAML block: every top-level scalar / string-list key, in
// file order. Keys whose value the flat model can't represent (nested
// maps, non-scalar list items) are absent here; on write they stay
// foreign and mergeFrontmatter preserves their original lines verbatim.
//
// Order is load-bearing: the panel renders rows in `fm` order and the
// flush emits keys in `fm` order, so the YAML key order in the file IS
// the persisted row order (the Obsidian model — no separate order store
// to drift from the file).

import { DOC_STATUS_VALUES, type DocMetaFile, type DocStatus } from '@/lib/docPaths'
import type { FrontmatterValue } from '@/lib/frontmatter'
import { normalizeTags } from '@/lib/tags'

/** One frontmatter entry: the raw key and its raw string(-list) value,
 *  exactly as parsed by `splitFrontmatterFull` (source-text fidelity,
 *  no type coercion). */
export interface FmEntry {
  key: string
  value: string | string[]
}

/** Project `splitFrontmatterFull(...).data` into the ordered entry list.
 *  JS objects preserve string-key insertion order, and the YAML parser
 *  inserts keys in document order, so `Object.entries` IS the file order.
 *  Returns undefined for an empty block so docs without frontmatter don't
 *  carry an empty array through the catalog. */
export function fmEntriesFromData(
  data: Record<string, string | string[]>,
): FmEntry[] | undefined {
  const entries = Object.entries(data).map(([key, value]) => ({ key, value }))
  return entries.length > 0 ? entries : undefined
}

// ── Key classification ────────────────────────────────────────────────

/** Panel key → the DocMetaFile field that owns its VALUE. For these keys
 *  the typed catalog fields stay authoritative (the AI relay and the
 *  dedicated controls write them); `fm` contributes only the position.
 *  At flush time values are re-injected from meta, so a stale fm mirror
 *  can never write a stale value to disk. */
export const TYPED_KEY_TO_META = {
  created: 'createdAt',
  source: 'sourceUrl',
  siteName: 'siteName',
  faviconUrl: 'faviconUrl',
  savedAt: 'savedAt',
  readAt: 'readAt',
  videoId: 'videoId',
  durationSec: 'durationSec',
  thumbnailUrl: 'thumbnailUrl',
  description: 'description',
  status: 'status',
  tags: 'tags',
} as const satisfies Record<string, keyof DocMetaFile>

export type TypedPanelKey = keyof typeof TYPED_KEY_TO_META

/** Legacy on-disk names → their standard panel key. A note saved before
 *  the field rename keeps its row position: the alias substitutes the
 *  standard key at the legacy key's slot. */
const LEGACY_KEY_ALIAS: Record<string, TypedPanelKey> = {
  createdAt: 'created',
  sourceUrl: 'source',
}

/** Append order for typed keys that carry a value but aren't in `fm`
 *  yet (fresh docs, fields set after load). Matches the emission order
 *  of `portableFrontmatterFields` so a doc that has never been
 *  panel-reordered serializes byte-identically through either flush
 *  branch. */
const CANONICAL_TYPED_ORDER: TypedPanelKey[] = [
  'created',
  'source',
  'siteName',
  'faviconUrl',
  'savedAt',
  'readAt',
  'videoId',
  'durationSec',
  'thumbnailUrl',
  'description',
  'status',
  'tags',
]

/** Keys never rendered as panel rows. `slug` is app-private (ephemeral
 *  per-boot handle) — legacy notes that still carry it on disk have it
 *  claimed-and-dropped on their next save. */
export const HIDDEN_PROPERTY_KEYS: readonly string[] = ['slug']

/** Names addDocProperty / renameDocProperty reject: app-private or
 *  legacy spellings that the write path claims-and-drops — letting a
 *  user create them would have their value silently deleted on save. */
export const RESERVED_PROPERTY_KEYS: readonly string[] = [
  'slug',
  'createdAt',
  'sourceUrl',
]

/** Current value of a typed panel key, from the authoritative meta.
 *  Strings stay strings, `tags` stays a list, numbers stringify (YAML
 *  scalars are untyped text). Undefined when the field is unset. */
function typedValueOf(
  meta: Partial<DocMetaFile>,
  key: TypedPanelKey,
): string | string[] | undefined {
  const v = meta[TYPED_KEY_TO_META[key]]
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) return v.length > 0 ? v : undefined
  return String(v)
}

// ── The panel/flush union ─────────────────────────────────────────────

/**
 * The single ordered view BOTH the panel and the flush render from —
 * sharing it is what makes "screen order = file order" true by
 * construction.
 *
 * Union rule: `fm` entries in file order (legacy keys aliased in place,
 * hidden keys dropped, duplicates first-wins), then typed keys that
 * carry a value but aren't placed yet, in canonical order.
 *
 * Typed keys re-inject their value from `meta` (fm's copy may be stale —
 * meta is authoritative). A typed key present in fm whose meta value is
 * empty keeps its row as a placeholder (`''` / `[]`) so its position
 * survives in-session; the emitter drops empty values, so placeholders
 * never reach disk.
 */
export function effectiveEntries(
  fm: FmEntry[] | undefined,
  meta: Partial<DocMetaFile>,
): FmEntry[] {
  const result: FmEntry[] = []
  const seen = new Set<string>()
  for (const entry of fm ?? []) {
    const key = LEGACY_KEY_ALIAS[entry.key] ?? entry.key
    if (HIDDEN_PROPERTY_KEYS.includes(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    if (key in TYPED_KEY_TO_META) {
      const typedKey = key as TypedPanelKey
      const value = typedValueOf(meta, typedKey)
      result.push({ key, value: value ?? (typedKey === 'tags' ? [] : '') })
    } else {
      result.push({ key, value: entry.value })
    }
  }
  for (const key of CANONICAL_TYPED_ORDER) {
    if (seen.has(key)) continue
    const value = typedValueOf(meta, key)
    if (value !== undefined) result.push({ key, value })
  }
  return result
}

/** Patch for the typed catalog fields when a TYPED panel key's value is
 *  edited generically (setDocProperty / addDocProperty). Coerces the raw
 *  panel value into the field's shape; empty clears the field. Returns
 *  null when the value can't be accepted (unknown status, non-numeric
 *  duration) — the caller rejects the edit rather than writing garbage.
 *  Spread the result over the KnownDoc row (fields are explicitly
 *  undefined on clear, same trick the dedicated setters use). */
export function typedFieldPatch(
  key: TypedPanelKey,
  value: string | string[],
): Partial<DocMetaFile> | null {
  if (key === 'tags') {
    const tags = normalizeTags(Array.isArray(value) ? value : [value])
    return { tags: tags.length > 0 ? tags : undefined }
  }
  if (Array.isArray(value)) return null
  const trimmed = value.trim()
  if (key === 'status') {
    if (trimmed === '') return { status: undefined }
    if (!(DOC_STATUS_VALUES as readonly string[]).includes(trimmed)) return null
    return { status: trimmed as DocStatus }
  }
  if (key === 'durationSec') {
    if (trimmed === '') return { durationSec: undefined }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return null
    return { durationSec: n }
  }
  return { [TYPED_KEY_TO_META[key]]: trimmed === '' ? undefined : trimmed }
}

/** Patch that CLEARS a typed panel key's catalog field (delete / rename
 *  de-typing). Empty for custom keys — spreading it is a no-op. */
export function clearTypedFieldPatch(key: string): Partial<DocMetaFile> {
  if (!(key in TYPED_KEY_TO_META)) return {}
  return { [TYPED_KEY_TO_META[key as TypedPanelKey]]: undefined }
}

/**
 * Flush-side record for the properties-dirty branch: {@link
 * effectiveEntries} as an insertion-ordered record (mergeFrontmatter
 * emits app fields in record order), plus claims that make every
 * app-representable key app-owned:
 *
 *   - the legacy spellings + `slug`, always (lazy migration), and
 *   - every scalar/list key of the CURRENT on-disk block
 *     (`existingData`) not already emitted — this is what makes a
 *     panel DELETE stick: the removed key is claimed as `undefined`,
 *     so mergeFrontmatter drops its line instead of preserving it.
 *
 * Claims sit after the ordered keys; their `undefined` values never
 * emit, so their record position is irrelevant. Keys `existingData`
 * can't represent (nested maps) are never claimed → preserved verbatim.
 */
export function orderedFrontmatterFields(
  fm: FmEntry[] | undefined,
  meta: Partial<DocMetaFile>,
  existingData: Record<string, string | string[]> = {},
): Record<string, FrontmatterValue | undefined> {
  const fields: Record<string, FrontmatterValue | undefined> = {}
  for (const entry of effectiveEntries(fm, meta)) {
    fields[entry.key] = entry.value
  }
  for (const key of RESERVED_PROPERTY_KEYS) {
    if (!(key in fields)) fields[key] = undefined
  }
  for (const key of Object.keys(existingData)) {
    if (!(key in fields)) fields[key] = undefined
  }
  return fields
}
