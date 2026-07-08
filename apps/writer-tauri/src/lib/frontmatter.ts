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
