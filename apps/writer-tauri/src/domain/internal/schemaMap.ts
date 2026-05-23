/**
 * Map MarkKind ↔ ProseMirror schema mark name.
 *
 * The domain layer speaks in `MarkKind` ('suggestion' | 'comment' |
 * 'authored'). The editor schema speaks in `proofSuggestion` /
 * `proofComment` / `proofAuthored`. This module is the single place
 * those two vocabularies meet, so the markStore implementation
 * doesn't sprinkle string literals through its code.
 *
 * The names match the proof-sdk mark schemas (`@proof-sdk/editor/
 * schema/proof-marks`) for now — Phase 3 will replace the imported
 * schema with locally-defined ones, but the schema mark names stay
 * the same so the PM marks already on user docs continue to render.
 */

import type { MarkKind } from '../marks'

const KIND_TO_SCHEMA: Record<MarkKind, string> = {
  suggestion: 'proofSuggestion',
  comment: 'proofComment',
  authored: 'proofAuthored',
}

const SCHEMA_TO_KIND: Record<string, MarkKind> = {
  proofSuggestion: 'suggestion',
  proofComment: 'comment',
  proofAuthored: 'authored',
}

/** Translate a domain MarkKind to the PM schema mark name. */
export function schemaNameForKind(kind: MarkKind): string {
  return KIND_TO_SCHEMA[kind]
}

/** Reverse lookup. Returns null when the PM schema name is not one
 * we recognize — callers (e.g. read-side filters) skip unknown
 * marks rather than treat them as one of ours. */
export function kindForSchemaName(name: string): MarkKind | null {
  return SCHEMA_TO_KIND[name] ?? null
}

/** All schema mark names the markStore acts on. Used by the
 * cleanup/cleanupMark path to scope its scan to proof marks
 * instead of all PM marks (bold/italic etc. must not be removed). */
export const PROOF_SCHEMA_MARK_NAMES: readonly string[] = [
  'proofSuggestion',
  'proofComment',
  'proofAuthored',
]
