// Why a proposed change did or didn't land.
//
// Lives in its own module because TWO edit-application walks need to report it
// and they must NOT be merged: `editor/cmHunks.placeEdits` (in-buffer green,
// inserts an `add` at its anchor) and `lib/pendingDiff.placeEditsInSnapshot`
// (chat card + same-turn merge, appends an `add` with a blank-line separator).
// The divergence is deliberate and documented at length in cmHunks' header;
// unifying the semantics is a separate job with its own risk. Sharing the
// VERDICT is safe and is what stops the two paths from disagreeing about
// whether an edit landed, which is the failure this type exists to prevent.
//
// The three failures are not interchangeable when reported to a model:
//   - `absent`    — the targeted text isn't there. Show what IS there.
//   - `ambiguous` — it's there several times. Ask for more surrounding context.
//   - `noop`      — nothing to do (already reads the way the model wants).
// `noop` in particular must be reported as SUCCESS. Refusing it starts a retry
// loop the model cannot escape: it re-reads, sees the text already correct,
// proposes the same edit, and is refused again.
export type Placement =
  | { kind: 'ok' }
  | { kind: 'noop' }
  | { kind: 'absent'; editIndex: number; target: string }
  | { kind: 'ambiguous'; editIndex: number; target: string }
