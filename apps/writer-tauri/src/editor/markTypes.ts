// Single source of truth for the set of proof mark names the editor
// plugins recognize. Each plugin needs a different subset depending
// on what it cares about; rather than duplicating string arrays
// across files (and risking a new mark type being added in one
// place but missed in another), the three meaningful groupings are
// named and exported once here.
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
// proofFlagged is in ALL (the schema reserves it for the future
// fact-check feature — see proof-marks.ts) but NOT in INTERACTIVE
// yet, because no UI surface creates / handles it.

export const ALL_PROOF_MARK_NAMES = [
  'proofSuggestion',
  'proofComment',
  'proofFlagged',
  'proofAuthored',
] as const

export const INTERACTIVE_PROOF_MARK_NAMES = [
  'proofSuggestion',
  'proofComment',
] as const

export const ANCHOR_PROOF_MARK_NAMES = ['proofSuggestion', 'proofComment'] as const

export type ProofMarkName = (typeof ALL_PROOF_MARK_NAMES)[number]
