// TEMPORARY diagnostic for R1 ("caret jumps left on input"). R1 isn't
// reproducible headlessly (it lives in the browser DOM-input/measure path), so
// this updateListener watches live editing and logs ONLY when the caret ends up
// LEFT of where the edit should have placed it — i.e. the bug firing. Reproduce
// in the dev route, then copy the `[R1-probe]` console lines back.
//
// Remove once R1 is fixed + verified.

import { EditorView } from '@codemirror/view'
import { isComposing } from './imeComposition'

export const r1Probe = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return
  const before = u.startState.selection.main.head
  const after = u.state.selection.main.head
  // Where the old caret SHOULD land after this edit (bias forward, like typing).
  const expected = u.changes.mapPos(before, 1)
  if (after >= expected) return // normal — caret advanced (or stayed) as expected

  // Anomaly: caret moved LEFT of the edit. Capture the context.
  let inserted = ''
  let changeFrom = -1
  u.changes.iterChanges((_fromA, _toA, fromB, _toB, ins) => {
    if (changeFrom < 0) changeFrom = fromB
    inserted += ins.toString()
  })
  // Flat one-line message so it survives console collapse / copy-paste. The
  // decisive pair is viewComposing vs fieldComposing: if they DISAGREE, our
  // state flag lagged the real composition (timing hole → recompute mid-IME).
  // eslint-disable-next-line no-console
  console.warn(
    `[R1-probe] LEFT jump | before=${before} expected=${expected} after=${after} ` +
      `ins=${JSON.stringify(inserted)} at=${changeFrom} ` +
      `viewComposing=${u.view.composing} fieldComposing=${isComposing(u.state)} ` +
      `line=${JSON.stringify(u.state.doc.lineAt(after).text)}`,
  )
})
