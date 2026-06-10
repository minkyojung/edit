// Robust vertical-arrow motion across tall block widgets.
//
// CM's ArrowUp/Down uses a SCREEN-pixel scan (moveVertically): it walks up/down the
// goal x-column looking for the next caret spot. When it must cross STACKED block
// widgets — a table block, a 240px image, the proof preview tile, the blank lines
// between them — the scan overshoots and lands many lines away (observed: line 21 →
// line 13, skipping the image AND the table).
//
// Fix philosophy = the same one `tableArrowEntry` already uses for tables: where the
// screen-based motion is unreliable, decide the move from the RAW document instead.
// But we touch ONLY the broken case: we let CM compute its move, and if it lands on
// the genuinely-adjacent line we return false and leave normal text entirely on CM's
// own (well-tested, goal-column-tracking) path. We override only when CM OVERSHOT.
// Table ENTRY stays with tableArrowEntry, which must be registered before this.

import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

// Is the caret on the first / last VISUAL row of its line? (A line may wrap into
// several rows.) Compare the caret's screen-top with the line's first/last char —
// same coordinate space, so no document/viewport conversion needed.
const onFirstRow = (view: EditorView, head: number, lineFrom: number): boolean => {
  const c = view.coordsAtPos(head)
  const s = view.coordsAtPos(lineFrom)
  return !c || !s || c.top - s.top <= 4
}
const onLastRow = (view: EditorView, head: number, lineTo: number): boolean => {
  const c = view.coordsAtPos(head)
  const e = view.coordsAtPos(lineTo)
  return !c || !e || e.top - c.top <= 4
}

function guard(view: EditorView, forward: boolean): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const head = sel.head
  const line = state.doc.lineAt(head)
  // Only act when the arrow EXITS the current line (caret on the edge visual row);
  // an intra-line move between wrapped rows is CM's job.
  if (forward ? !onLastRow(view, head, line.to) : !onFirstRow(view, head, line.from)) return false
  const adjNo = forward ? line.number + 1 : line.number - 1
  if (adjNo < 1 || adjNo > state.doc.lines) return false

  // What does CM want to do? If it lands on the genuinely-adjacent line (or stays on
  // this one), it's correct — return false so CM handles it and keeps its goal column.
  const cmNo = state.doc.lineAt(view.moveVertically(sel, forward).head).number
  if (forward ? cmNo <= adjNo : cmNo >= adjNo) return false // not an overshoot

  // Overshoot: CM skipped past block widget(s). Land on the adjacent line at the
  // caret's current x (goal column), on that line's near visual row.
  const adj = state.doc.line(adjNo)
  const goalX = view.coordsAtPos(head)?.left
  const block = view.lineBlockAt(adj.from)
  const y = view.documentTop + (forward ? block.top + 3 : block.bottom - 3)
  let pos = goalX != null ? view.posAtCoords({ x: goalX, y }) : null
  if (pos == null) pos = forward ? adj.from : adj.to
  pos = Math.max(adj.from, Math.min(adj.to, pos)) // never land inside a block above/below adj
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  return true
}

export const blockVerticalNav = Prec.highest(
  keymap.of([
    { key: 'ArrowUp', run: (v) => guard(v, false) },
    { key: 'ArrowDown', run: (v) => guard(v, true) },
  ]),
)
