/**
 * Deserializer — takes the two files (md + sidecar) and produces the doc
 * state with each mark resolved to its current position (or marked orphaned).
 *
 * The prototype lives at the plain-text + char-offset layer, so "deserialize"
 * is just "for each sidecar entry, resolve its anchor against the md text."
 * Real implementation would parse md → PM doc here and convert char offsets
 * to PM positions — but that's a wrapping step that doesn't affect whether
 * the anchor resolves in the first place.
 */

import { resolveAnchor, type ResolverOptions } from './markResolver.js'
import type { DeserializedDoc, MarksSidecarFile, ResolvedMark } from './types.js'

export function deserialize(
  md: string,
  sidecar: MarksSidecarFile,
  options?: ResolverOptions,
): DeserializedDoc {
  const marks: ResolvedMark[] = sidecar.marks.map((entry) => {
    const result = resolveAnchor(md, entry.anchor, options)
    return {
      id: entry.id,
      kind: entry.kind,
      attrs: entry.attrs,
      status: result.status,
      range: result.range,
      anchor: entry.anchor,
    }
  })

  return { plainText: md, marks }
}
