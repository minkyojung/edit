// Single source of truth for the set of proof mark names the editor
// plugins recognize. Each plugin needs a different subset depending
// on what it cares about; rather than duplicating string arrays
// across files (and risking a new mark type being added in five
// places but missed in the sixth), the three meaningful groupings
// are named and exported once here.
//
//   ALL_PROOF_MARK_NAMES         — every proof mark the schema
//                                   defines. Used by inlineCodeSafe
//                                   to leave proof marks alone when
//                                   the user toggles inline code on
//                                   a range.
//
//   INTERACTIVE_PROOF_MARK_NAMES — proof marks that have a UI
//                                   lifecycle (the user can click /
//                                   accept / reject / resolve them).
//                                   Used by markClickPlugin and
//                                   markCleanupPlugin to decide
//                                   which marks merit a global
//                                   click event or a Y.Map cleanup
//                                   when their inline anchor goes
//                                   away.
//
//   ANCHOR_PROOF_MARK_NAMES      — proof marks the user can directly
//                                   act on (accept / reject). The
//                                   strict subset of INTERACTIVE
//                                   that markActions.findInlineAnchor
//                                   searches over.
//
// Memberships were lifted verbatim from the prior inline definitions
// and intentionally NOT widened or narrowed in this refactor — the
// goal is to centralize the list, not to change behavior.

export const ALL_PROOF_MARK_NAMES = [
  'proofSuggestion',
  'proofComment',
  'proofFlagged',
  'proofApproved',
  'proofAuthored',
  'proofProvenance',
] as const

export const INTERACTIVE_PROOF_MARK_NAMES = [
  'proofSuggestion',
  'proofComment',
  'proofFlagged',
  'proofApproved',
] as const

export const ANCHOR_PROOF_MARK_NAMES = ['proofSuggestion', 'proofComment'] as const

export type ProofMarkName = (typeof ALL_PROOF_MARK_NAMES)[number]
