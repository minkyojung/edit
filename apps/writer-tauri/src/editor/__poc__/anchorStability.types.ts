// Editor-NEUTRAL contracts for the anchor-stability harness.
//
// Phase 0 of the ProseMirror→CodeMirror evaluation (see
// docs/codemirror-migration-poc-plan.md). The harness measures whether
// an AI edit suggestion stays pinned to the correct text after the user
// makes arbitrary edits before accepting. The SAME fixtures + harness
// run against the current PM impl now (the control) and a CM prototype
// in Phase 2 — so everything here is deliberately editor-agnostic.
// Each editor supplies an EditorAdapter that materialises the fixture
// markdown into its own model.

import type { PendingEdit } from '@/state/pendingChangesStore'

/** A simulated user edit. Located by a literal `find` substring so both
 * editors resolve it with a DUMB search (indexOf / textContent.indexOf)
 * — never the anchor logic under test, which would make the measurement
 * circular. `find` must be present verbatim in the current body. */
export type Op =
  | { kind: 'insertText'; find: string; where: 'before' | 'after'; text: string }
  | { kind: 'deleteText'; find: string }
  | { kind: 'replaceText'; find: string; text: string }
  | { kind: 'insertBlock'; afterFind: string; markdown: string }
  | { kind: 'deleteBlock'; find: string }

export type AnchorStatus = 'placed' | 'hunks' | 'unplaced' | 'silent'

export type FixtureGroup =
  | 'single-anchor' // pure PM-position signal (placed, from/to/insertAt)
  | 'drift' //         pure PM-position signal under nearby edits
  | 'unplaced' //      re-resolution promotion
  | 'hunks' //         disk-derived bucket (reported separately)
  | 'block-add' //     materialise + accept fidelity

export interface Fixture {
  name: string
  group: FixtureGroup
  /** Markdown body — the single source of truth. Each adapter builds its
   * own model from this (PM hand-parses it; CM uses it verbatim). */
  initialBody: string
  /** The AI suggestion under test. */
  edit: PendingEdit
  /** A deterministic, named sequence of user edits (regression case). */
  userEditScript?: Op[]
  /** Tokens elsewhere in the body that the random generator may edit
   * around — used to prove UNRELATED edits don't disturb the anchor.
   * Must not overlap the anchor's target text. */
  safeTokens?: string[]
  // ── Expectations (assert only the ones provided) ──────────────────
  /** After the edits, the mapped anchor's covered text must equal this
   * (placed replace/delete only). */
  expectedTargetText?: string | null
  /** After the edits, the text immediately before insertAt must end
   * with this (add / block-add only). */
  expectedTextBeforeInsert?: string
  /** Resolution status the anchor must hold after the edits. */
  expectedStatus?: AnchorStatus
  /** Accept-fidelity (secondary): the final body after Keep. */
  expectedBody?: string
}

/** What an adapter reports about the suggestion's CURRENT (mapped)
 * placement, read after each user edit. */
export interface AnchorProbe {
  status: AnchorStatus
  /** textBetween(from, to) when the anchor is `placed` with a range. */
  targetText: string | null
  /** Text ending at insertAt (tail-trimmed) when insertAt is defined. */
  textBeforeInsert: string | null
}

/** An editor's implementation of the harness contract. `H` is the
 * adapter's opaque handle (PM: {state, …}; CM: {view/state, …}). */
export interface EditorAdapter<H> {
  /** Build the editor state from the fixture + register the pending
   * edit, then resolve the anchor once (initial placement). */
  init(fixture: Fixture): H
  /** Apply one simulated user edit, keeping the body model and the
   * disk-side bodyMarkdown in sync (mirrors the real PM==disk invariant).
   * Returns the next handle. */
  applyUserOp(handle: H, op: Op): H
  /** Read the suggestion's currently-mapped placement. */
  probe(handle: H): AnchorProbe
  /** Accept (Keep) the suggestion and return the resulting body markdown. */
  accept(handle: H): string
  /** Per-run teardown (reset shared singleton stores). */
  dispose(handle: H): void
}
