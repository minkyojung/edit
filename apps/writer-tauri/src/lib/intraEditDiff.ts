// Intra-edit diff: trim the unchanged head/tail of a replace.
//
// A `propose_edit` carries an explicit (before → after). The model
// often expresses an INSERTION as a replace whose `before` is the
// anchor line and whose `after` is that same line plus the new
// content — e.g. before "성별: 남자", after "성별: 남자\n직업: 청소부".
// Rendering the whole `before` as removed and the whole `after` as
// added then double-shows the unchanged anchor (struck red AND green).
//
// This is NOT the lossy whole-document diff Path A removed — here both
// strings are short, known, and exact. Stripping their longest common
// prefix + suffix isolates the part that actually changed so the diff
// shows only that.

export interface EditSplit {
  /** Char length of the shared leading run (unchanged head). */
  prefixLen: number
  /** Char length of the shared trailing run (unchanged tail), never
   * overlapping the prefix. */
  suffixLen: number
  /** The slice of `before` that is actually removed. */
  removed: string
  /** The slice of `after` that is actually added. */
  added: string
}

/** Longest-common-prefix + longest-common-suffix split of (before,
 * after). Operates on UTF-16 code units; for BMP text (incl. Korean)
 * that equals characters, and surrogate pairs at a boundary only cost
 * a slightly wider diff, never a wrong one. */
export function splitEdit(before: string, after: string): EditSplit {
  const max = Math.min(before.length, after.length)

  let prefixLen = 0
  while (prefixLen < max && before[prefixLen] === after[prefixLen]) {
    prefixLen += 1
  }

  let suffixLen = 0
  while (
    suffixLen < max - prefixLen &&
    before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
  ) {
    suffixLen += 1
  }

  return {
    prefixLen,
    suffixLen,
    removed: before.slice(prefixLen, before.length - suffixLen),
    added: after.slice(prefixLen, after.length - suffixLen),
  }
}
