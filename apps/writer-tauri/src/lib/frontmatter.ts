// Generic frontmatter plumbing — the read/write layer for the small
// YAML `---` block that carries a document's metadata at the top of its
// `.md` file.
//
// Deliberately dependency-free and limited to a flat `key: value` block
// of scalars, matching the convention already used by
// profile/sources.ts and chat/commands/loader.ts. We don't pull in a
// YAML library: the surface we emit and read is narrow, and we'd rather
// own the exact escaping than inherit a parser's quirks. (Those two
// existing call sites stay as-is for now — this module is the shared
// foundation new frontmatter work builds on.)
//
// Boundary: frontmatter is only recognised when the file *starts* with a
// `---` line AND has a matching closing `---` line. A body that happens
// to begin with a `---` thematic break but has no closing delimiter is
// treated as having no frontmatter. We always write a real block, so in
// practice this ambiguity only touches files we didn't author.

/** Values we know how to emit. Everything reads back as a string —
 *  YAML scalars are untyped text, so the caller coerces (e.g.
 *  `Number(data.archivedAt)`) at the point of use. */
export type FrontmatterScalar = string | number | boolean

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
  fields: Record<string, FrontmatterScalar | undefined | null>,
  body: string,
): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${escapeYamlValue(String(v))}`)

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
 */
export function splitFrontmatter(raw: string): SplitDoc {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { data: {}, body: raw }

  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue // skip lines we can't read rather than fail
    const key = line.slice(0, colon).trim()
    if (key) data[key] = unescapeYamlValue(line.slice(colon + 1).trim())
  }

  return { data, body: (m[2] ?? '').replace(/^(?:\r?\n)+/, '') }
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
  appFields: Record<string, FrontmatterScalar | undefined | null>,
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
      } else if (!ownedByApp) {
        // Continuation (indented), comment, blank, or top-level list item —
        // belongs to the current key's group (or floats). Keep unless the
        // current group is an app-owned key being dropped.
        preserved.push(line)
      }
    }
  }

  const appLines = Object.entries(appFields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${escapeYamlValue(String(v))}`)

  const lines = [...preserved, ...appLines]
  const trimmedBody = newBody.replace(/^\n+/, '')
  if (lines.length === 0) {
    return trimmedBody.endsWith('\n') ? trimmedBody : `${trimmedBody}\n`
  }
  return `---\n${lines.join('\n')}\n---\n\n${trimmedBody}${
    trimmedBody.endsWith('\n') ? '' : '\n'
  }`
}

// ── YAML scalar escaping ──────────────────────────────────────────────
// Mirrors profile/sources.ts: we quote only when a value would otherwise
// be misread, and double single-quotes inside per YAML. Not full YAML —
// the read side mirrors this same narrow surface.

function escapeYamlValue(value: string): string {
  const needsQuote = /[:#]|^\s|\s$|^["'[\]{}|>!%@&*]/.test(value)
  if (!needsQuote) return value
  return `'${value.replace(/'/g, "''")}'`
}

function unescapeYamlValue(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}
