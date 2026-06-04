// Encoding of the fenced-code-block `meta` string used by code-block-ext.
// Format: `v:<id>` (viz block id) optionally followed by `proof:<base64>`
// (encoded proof marks). Either token may be absent. Kept pure and separate so
// it's unit-testable without loading the Milkdown schema.

const VIZ_ID_RE = /(?:^|\s)v:([A-Za-z0-9_-]+)/

/** Extract the viz block id from a fence meta string, or '' if none. */
export function decodeVizIdFromMeta(meta: string | undefined): string {
  if (!meta) return ''
  const m = VIZ_ID_RE.exec(meta)
  return m ? m[1] : ''
}

/** Combine a viz id + already-encoded proof marks into a fence meta string. The
 * id comes first so the base64 proof token stays the trailing one. Returns null
 * when both are empty (i.e. no meta). */
export function buildFenceMeta(vizId: string, encodedMarks: string): string | null {
  const meta = [vizId ? `v:${vizId}` : '', encodedMarks].filter(Boolean).join(' ')
  return meta || null
}
