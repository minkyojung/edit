// Mark domain ↔ sidecar adapter.
//
// The sidecar JSON shape (types.ts) carries a flat MarkKind enum
// inherited from the prototype: `'authored' | 'comment' | 'insert' |
// 'delete' | 'replace' | ...`. Our runtime domain (`domain/marks.ts`)
// narrowed that to 3 kinds (`'suggestion' | 'comment' | 'authored'`)
// with `suggestionType` discriminating insert/delete/replace inside
// `suggestion`. This module is the only place those two vocabularies
// meet, so the serializer / deserializer never have to think about
// the nested model, and the markStore never has to think about the
// flat one.
//
// Why a flat sidecar instead of nesting suggestionType into the JSON?
// External tools (qmd / git diff / vim-side scripts) need a single
// mark-kind field they can grep / index without parsing a sub-object.
// Flat happens to also match the prototype + its 90% roundtrip
// benchmark; not breaking the existing fixtures keeps that safety
// net intact while we wire 4.B.

import type { Mark, MarkKind, MarkStatus, SuggestionType } from '@/domain/marks'
import type { AnchorSpec, MarkKind as SidecarMarkKind, MarkSidecar } from './types'

/** Sidecar attrs that carry the domain fields lost when collapsing
 * Mark → flat MarkSidecar. Kept as plain strings so the JSON is
 * forward-compatible with future field additions. */
interface SidecarAttrs extends Record<string, string | null | undefined> {
  by: string
  createdAt: string
  status: MarkStatus
  startRel: string
  endRel: string
  acceptedAt?: string
  content?: string
  text?: string
  rationale?: string
  sourceSlug?: string
  sourceLabel?: string
  sourceQuote?: string
  model?: string
}

/** Map a domain Mark to the flat sidecar kind. Suggestion marks
 * unfold into one of `insert / delete / replace` depending on
 * `suggestionType`; comment + authored map straight across. */
function domainKindToSidecarKind(mark: Mark): SidecarMarkKind {
  if (mark.kind === 'suggestion') {
    return (mark.suggestionType ?? 'replace') as SidecarMarkKind
  }
  return mark.kind
}

/** Inverse of {@link domainKindToSidecarKind}. Folds `insert/delete/
 * replace` back into `kind: 'suggestion' + suggestionType`. Returns
 * null for sidecar kinds we no longer recognise (e.g. the legacy
 * `flagged` / `approved` / `provenance` left over from prototypes —
 * those marks get dropped on load rather than misrendered). */
function sidecarKindToDomain(kind: SidecarMarkKind): {
  kind: MarkKind
  suggestionType?: SuggestionType
} | null {
  if (kind === 'comment' || kind === 'authored') {
    return { kind }
  }
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') {
    return { kind: 'suggestion', suggestionType: kind }
  }
  return null
}

/** Build the sidecar entry for one domain Mark. Anchor is provided
 * by the caller — markAdapter doesn't compute char offsets itself
 * because that lives one layer up (Y.Doc → text + positions).
 *
 * The anchor's `quote` should match the live text at the mark's
 * current range; the serializer enforces this when emitting the
 * sidecar from a known doc body, so we trust the caller. */
export function markToSidecar(mark: Mark, anchor: AnchorSpec): MarkSidecar {
  const attrs: SidecarAttrs = {
    by: mark.by,
    createdAt: mark.createdAt,
    status: mark.status,
    startRel: mark.startRel,
    endRel: mark.endRel,
  }
  if (mark.acceptedAt !== undefined) attrs.acceptedAt = mark.acceptedAt
  if (mark.content !== undefined) attrs.content = mark.content
  if (mark.text !== undefined) attrs.text = mark.text
  if (mark.rationale !== undefined) attrs.rationale = mark.rationale
  if (mark.sourceSlug !== undefined) attrs.sourceSlug = mark.sourceSlug
  if (mark.sourceLabel !== undefined) attrs.sourceLabel = mark.sourceLabel
  if (mark.sourceQuote !== undefined) attrs.sourceQuote = mark.sourceQuote
  if (mark.model !== undefined) attrs.model = mark.model

  return {
    id: mark.id,
    kind: domainKindToSidecarKind(mark),
    attrs,
    anchor,
  }
}

/** Build a domain Mark from a sidecar entry plus the resolved range
 * (which the markResolver returned by re-anchoring against the
 * loaded body). Returns null for sidecar entries we can't map back
 * — unknown kind, or a malformed attrs shape (missing required
 * status/by/createdAt). The caller surfaces these as "skipped on
 * load" rather than throwing, since one bad entry shouldn't drop
 * the whole sidecar. */
export function sidecarToMark(sidecar: MarkSidecar): Mark | null {
  const kindMap = sidecarKindToDomain(sidecar.kind)
  if (!kindMap) return null

  const attrs = sidecar.attrs as Partial<SidecarAttrs>
  if (!attrs.by || !attrs.createdAt || !attrs.status) return null
  if (!attrs.startRel || !attrs.endRel) return null

  const mark: Mark = {
    id: sidecar.id,
    kind: kindMap.kind,
    quote: sidecar.anchor.quote,
    startRel: attrs.startRel,
    endRel: attrs.endRel,
    status: attrs.status,
    by: attrs.by,
    createdAt: attrs.createdAt,
  }
  if (kindMap.suggestionType) mark.suggestionType = kindMap.suggestionType
  if (attrs.acceptedAt) mark.acceptedAt = attrs.acceptedAt
  if (attrs.content) mark.content = attrs.content
  if (attrs.text) mark.text = attrs.text
  if (attrs.rationale) mark.rationale = attrs.rationale
  if (attrs.sourceSlug) mark.sourceSlug = attrs.sourceSlug
  if (attrs.sourceLabel) mark.sourceLabel = attrs.sourceLabel
  if (attrs.sourceQuote) mark.sourceQuote = attrs.sourceQuote
  if (attrs.model) mark.model = attrs.model

  return mark
}
