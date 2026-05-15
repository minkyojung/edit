/**
 * Markdown export — pure serializer.
 *
 * Takes a page body + the marks attached to it and produces the two
 * artifacts the Level 3 export feature writes to disk:
 *   - `md`      — clean markdown body, unchanged from input
 *   - `sidecar` — `.marks.json` payload (semantic anchors per mark)
 *
 * Operates at the plain-text + char-offset layer. The wrapping flow
 * (exportPage) is responsible for translating from ProseMirror positions
 * + `StoredMark` entries to the (text, marks[]) shape this consumes —
 * keeping the serializer pure lets the prototype's roundtrip tests stay
 * useful here without simulated PM state.
 *
 * Anchor extraction:
 * - `quote`         exact substring the mark covered at export time
 * - `contextBefore` up to N chars immediately before the mark
 * - `contextAfter`  up to N chars immediately after the mark
 * - `occurrence`    0-indexed ordinal among all matches of `quote`
 *                   (computed before we lean on context; surrounding
 *                   text may itself repeat, so context alone is not a
 *                   sufficient disambiguator)
 *
 * The 32-char context window struck the right balance in the prototype
 * benchmark — wide enough to disambiguate near-duplicate quotes, narrow
 * enough that nearby unrelated edits don't invalidate it. See
 * `.context/prototype-git-storage/RESULTS.md` for the threshold sweep.
 */

import type {
  AnchorSpec,
  MarkKind,
  MarkSidecar,
  MarksSidecarFile,
  SerializedDoc,
} from './types'

const CONTEXT_WINDOW = 32

/**
 * Serializer input — a page's plain-text body plus a flat list of marks
 * positioned by char offset. The wrapping export flow translates from the
 * runtime shape (ProseMirror positions + `Y.Map<StoredMark>('marks')`) into
 * this representation; the serializer itself never reaches into PM or Yjs.
 */
export interface SerializerInput {
  text: string
  marks: Array<{
    id: string
    kind: MarkKind
    attrs: Record<string, string | null | undefined>
    /** Inclusive start char offset into `text`. */
    from: number
    /** Exclusive end char offset into `text`. */
    to: number
  }>
}

export function serialize(input: SerializerInput): SerializedDoc {
  const sidecarMarks: MarkSidecar[] = input.marks.map((mark) =>
    buildSidecarMark(input.text, mark),
  )

  const sidecar: MarksSidecarFile = {
    version: 1,
    marks: sidecarMarks,
  }

  return { md: input.text, sidecar }
}

function buildSidecarMark(
  text: string,
  mark: SerializerInput['marks'][number],
): MarkSidecar {
  const quote = text.slice(mark.from, mark.to)
  const occurrence = computeOccurrence(text, quote, mark.from)
  const anchor: AnchorSpec = {
    quote,
    contextBefore: text.slice(Math.max(0, mark.from - CONTEXT_WINDOW), mark.from),
    contextAfter: text.slice(mark.to, Math.min(text.length, mark.to + CONTEXT_WINDOW)),
    occurrence,
  }

  return {
    id: mark.id,
    kind: mark.kind,
    attrs: mark.attrs,
    anchor,
  }
}

/**
 * Count how many times `quote` appears in `text` strictly before
 * `targetStart`. Used to record the 0-indexed ordinal of the mark's match
 * so an importer can pin down the right occurrence even when context
 * windows themselves repeat (e.g. an entity that appears in identical
 * bulleted sentences on the same page).
 */
function computeOccurrence(text: string, quote: string, targetStart: number): number {
  if (!quote) return 0
  let count = 0
  let from = 0
  while (from <= text.length) {
    const idx = text.indexOf(quote, from)
    if (idx === -1 || idx > targetStart) break
    if (idx === targetStart) return count
    count += 1
    from = idx + 1
  }
  return count
}
