// Generic frontmatter plumbing — the read/write layer for the small
// YAML `---` block that carries a document's metadata at the top of its
// `.md` file. The single shared foundation for every frontmatter site
// (profile/sources.ts, chat/commands/loader.ts, the doc flush).
//
// Reading uses the `yaml` library (eemeli, YAML 1.2 core schema): it
// handles quoting, escaping, CRLF, and comments correctly, and — unlike
// js-yaml's default schema — leaves unquoted ISO dates as strings rather
// than coercing them to `Date`, which is load-bearing for the date-valued
// metadata fields (createdAt/savedAt/readAt). We read each scalar's
// *source text* (see splitFrontmatter) so a numeric-looking value keeps
// its exact form (no `007` → `7`, no precision loss).
//
// Writing stays hand-rolled on purpose (composeFrontmatter /
// mergeFrontmatter + escapeYamlValue): mergeFrontmatter preserves foreign
// keys, comments, and nested structures byte-for-byte by copying their
// original lines, which the flush's content-equality guard depends on. A
// library re-serialise would normalise (reorder keys, drop comments) and
// regress that. The library is parse-only here.
//
// Boundary: frontmatter is only recognised when the file *starts* with a
// `---` line AND has a matching closing `---` line. A body that happens
// to begin with a `---` thematic break but has no closing delimiter is
// treated as having no frontmatter. We always write a real block, so in
// practice this ambiguity only touches files we didn't author.

import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

/** Values we know how to emit. Everything reads back as a string —
 *  YAML scalars are untyped text, so the caller coerces (e.g.
 *  `Number(data.archivedAt)`) at the point of use. */
export type FrontmatterScalar = string | number | boolean

/** A value the write path can emit: a scalar, or a list of strings that
 *  serialises as a YAML block sequence (`key:\n  - a\n  - b`). */
export type FrontmatterValue = FrontmatterScalar | string[]

export interface SplitDoc {
  /** Parsed frontmatter fields, raw string values. Empty `{}` when the
   *  file has no frontmatter block. */
  data: Record<string, string>
  /** Everything after the closing `---`, with the single separating
   *  blank line trimmed. Equals the whole input when there's no
   *  frontmatter. */
  body: string
}

// Open `---`, capture the block, close `---`, then the rest. Tolerates
// CRLF and trailing spaces on the closing fence.
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/

/**
 * Compose a full `.md` file string from metadata fields and a body.
 *
 * Fields that are `undefined`, `null`, or `''` are dropped, so callers
 * can pass a wide record and let absent values fall away. When no field
 * survives, the body is returned on its own (no empty `---` block).
 */
export function composeFrontmatter(
  fields: Record<string, FrontmatterValue | undefined | null>,
  body: string,
): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => !isEmptyFieldValue(v))
    .map(([k, v]) => emitField(k, v as FrontmatterValue))

  const trimmedBody = body.replace(/^\n+/, '')
  if (lines.length === 0) {
    return trimmedBody.endsWith('\n') ? trimmedBody : `${trimmedBody}\n`
  }
  return `---\n${lines.join('\n')}\n---\n\n${trimmedBody}${
    trimmedBody.endsWith('\n') ? '' : '\n'
  }`
}

/**
 * Split a `.md` file string into its frontmatter fields and body. Never
 * throws: a missing or malformed block yields `{ data: {}, body: raw }`,
 * so a file that lost (or never had) frontmatter still loads its content.
 *
 * The block is *located* with {@link FRONTMATTER_RE} (start-of-file fence,
 * matching close, CRLF/trailing-space tolerant) and then *parsed* with the
 * YAML library in silent mode — malformed YAML degrades to whatever the
 * parser can still recover (a bad line never poisons the sibling keys) and
 * never propagates an exception.
 *
 * Only top-level scalar keys are exposed, as the exact source text of each
 * value (so `007` stays `'007'` and a large id keeps full precision). Keys
 * whose value is a nested map or list can't fit the flat `Record<string,
 * string>` contract and are skipped here; on write, {@link mergeFrontmatter}
 * preserves them verbatim.
 */
export function splitFrontmatter(raw: string): SplitDoc {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { data: {}, body: raw }
  return { data: parseFrontmatterBlock(m[1]), body: (m[2] ?? '').replace(/^(?:\r?\n)+/, '') }
}

/** Like {@link splitFrontmatter} but includes list-valued fields (`tags`)
 *  in `data` as `string[]`, for the metadata read path. See
 *  {@link parseFrontmatterFull}. */
export function splitFrontmatterFull(raw: string): {
  data: Record<string, string | string[]>
  body: string
} {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { data: {}, body: raw }
  return { data: parseFrontmatterFull(m[1]), body: (m[2] ?? '').replace(/^(?:\r?\n)+/, '') }
}

/**
 * Parse the inner text of a frontmatter block (the part *between* the `---`
 * fences, already sliced out) into its top-level scalar fields. Shared by
 * {@link splitFrontmatter} and the slash-command loader so both read YAML
 * through one implementation.
 *
 * Silent mode: malformed YAML degrades to whatever the parser can still
 * recover and never throws. Only top-level scalar keys are returned, as the
 * exact source text of each value (so `007` stays `'007'`); nested maps and
 * lists can't fit the flat `Record<string, string>` contract and are skipped.
 */
export function parseFrontmatterBlock(inner: string): Record<string, string> {
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseFrontmatterFull(inner))) {
    if (typeof value === 'string') data[key] = value
  }
  return data
}

/**
 * Like {@link parseFrontmatterBlock} but also returns top-level list
 * (sequence-of-scalars) values as `string[]`, for the metadata read path
 * that needs list fields such as `tags`. Scalars still come back as their
 * exact source text; nested maps and non-scalar list items are skipped.
 *
 * Kept separate so the scalar-only `parseFrontmatterBlock` contract (used by
 * the loader / sources / splitFrontmatter) is unchanged — only the meta
 * projection opts into lists.
 */
export function parseFrontmatterFull(
  inner: string,
): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {}
  const doc = parseDocument(inner, { logLevel: 'silent' })
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      if (!isScalar(item.key)) continue
      const key = String(item.key.value).trim()
      if (!key) continue
      const value = item.value
      // `.source` is the decoded scalar text: unquoted/unescaped for strings,
      // original token for numbers/booleans — no lossy type round-trip.
      if (isScalar(value)) {
        data[key] = value.source ?? String(value.value)
      } else if (isSeq(value)) {
        const items: string[] = []
        for (const el of value.items) {
          if (isScalar(el)) items.push(el.source ?? String(el.value))
        }
        if (items.length) data[key] = items
      }
    }
  }
  return data
}

/**
 * Rewrite a `.md` file's frontmatter: overlay the app's own scalar
 * fields (`slug`, `archivedAt`, …) while preserving EVERY other key in
 * the existing block **verbatim** — including lists, nested maps, and
 * comments that {@link splitFrontmatter}'s flat scalar view can't
 * represent.
 *
 * This is the write path for docs the app didn't originate (an Obsidian
 * page a user dropped in, a note with `tags:\n  - a\n  - b`). The naive
 * split→re-compose round-trip would flatten those structures to `''` and
 * silently destroy them; here the original lines are copied byte-for-byte
 * and only the app-owned keys are replaced/appended.
 *
 * Byte-stable for app-authored files: when the existing block contains
 * ONLY app keys, the output is identical to `composeFrontmatter(appFields,
 * newBody)`, so the flush's content-equality guard still short-circuits and
 * no phantom churn is introduced.
 *
 * @param existingFile  the current on-disk file (frontmatter is mined from
 *                      it; its body is ignored).
 * @param appFields     the app-owned fields to set. A key present here is
 *                      owned by the app: its old value in the file is
 *                      dropped, and it is re-emitted only when its value
 *                      survives the same `undefined/null/''` filter
 *                      `composeFrontmatter` uses.
 * @param newBody       the body to write below the block.
 */
export function mergeFrontmatter(
  existingFile: string,
  appFields: Record<string, FrontmatterValue | undefined | null>,
  newBody: string,
): string {
  const m = FRONTMATTER_RE.exec(existingFile)
  const appKeys = new Set(Object.keys(appFields))

  // Preserve every original line whose owning top-level key the app does
  // NOT manage. Lines are grouped by top-level key so a multi-line value
  // (list / nested map) travels with its key; floating comments and blank
  // lines (key === null) are always kept in place.
  const preserved: string[] = []
  if (m) {
    let ownedByApp = false
    for (const line of m[1].split(/\r?\n/)) {
      const keyMatch = /^([^\s#][^:]*?):(?:\s|$)/.exec(line)
      if (keyMatch) {
        ownedByApp = appKeys.has(keyMatch[1].trim())
        if (!ownedByApp) preserved.push(line)
      } else {
        // A non-indented comment or a blank line floats *between* key blocks,
        // so it's kept even when the preceding key is app-owned (a key's value
        // is only its indented continuation lines). An indented line belongs
        // to the current key's group and rides its ownership.
        const trimmed = line.trim()
        const floats = trimmed === '' || (trimmed.startsWith('#') && !/^[ \t]/.test(line))
        if (floats || !ownedByApp) preserved.push(line)
      }
    }
  }

  const appLines = Object.entries(appFields)
    .filter(([, v]) => !isEmptyFieldValue(v))
    .map(([k, v]) => emitField(k, v as FrontmatterValue))

  const lines = [...preserved, ...appLines]
  const trimmedBody = newBody.replace(/^\n+/, '')
  if (lines.length === 0) {
    return trimmedBody.endsWith('\n') ? trimmedBody : `${trimmedBody}\n`
  }
  return `---\n${lines.join('\n')}\n---\n\n${trimmedBody}${
    trimmedBody.endsWith('\n') ? '' : '\n'
  }`
}

// ── YAML scalar escaping (emit side) ──────────────────────────────────
// The write path stays hand-rolled and byte-stable: quote only when a
// value would otherwise be misread, doubling inner single-quotes per YAML.
// Reading is handled by the `yaml` library (see splitFrontmatter), so
// there is no matching unescape helper here.

function escapeYamlValue(value: string): string {
  const needsQuote = /[:#]|^\s|\s$|^["'[\]{}|>!%@&*]/.test(value)
  if (!needsQuote) return value
  return `'${value.replace(/'/g, "''")}'`
}

/** True for values the write path drops: absent scalars and empty lists.
 *  A non-empty list is kept even though it isn't a scalar. */
function isEmptyFieldValue(v: FrontmatterValue | undefined | null): boolean {
  if (Array.isArray(v)) return v.length === 0
  return v === undefined || v === null || v === ''
}

/** Emit one frontmatter field. Scalars render inline (`k: v`); a string
 *  list renders as a YAML block sequence:
 *
 *      k:
 *        - a
 *        - b
 *
 *  Scalar output is byte-identical to the previous scalar-only emitter, so
 *  the flush's content-equality guard is unaffected for scalar fields. */
function emitField(key: string, value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `${key}:\n${value.map((item) => `  - ${escapeYamlValue(item)}`).join('\n')}`
  }
  return `${key}: ${escapeYamlValue(String(value))}`
}
