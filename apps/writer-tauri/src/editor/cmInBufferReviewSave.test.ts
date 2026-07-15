// The reported bug: an AUTO-ACCEPTED pure-insertion (append) to the open note was
// silently lost. Root cause — accepting an append produces an EMPTY red range, so
// the CLEANUP dispatch carries no doc change; CmEditor's save listener bailed on
// `!docChanged` and never re-mirrored bodyMarkdown, even though the accept flipped
// the appended text from pending-green (EXCLUDED from the save) to accepted
// (INCLUDED). This pins the fix: a decision (accept/reject) transaction must
// re-mirror the saved body even with no doc change.
//
// The `savedBodyFor` helper below reproduces CmEditor.tsx's updateListener guard +
// body computation — but it calls the SAME `isDecisionTx` / `greenRangesForSave` /
// `stripRanges` the real listener uses, so the decision logic under test is the
// production code, not a copy. (The listener itself lives inside the React
// component and can't be mounted headlessly here.)
import { describe, it, expect } from 'vitest'
import { EditorState, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history } from '@codemirror/commands'
import {
  _matField,
  _setMat,
  _dropChange,
  _acceptEffect,
  greenRangesForSave,
  isDecisionTx,
} from './cmInBufferReview'
import { stripRanges } from './proposalPlan'

/** What CmEditor's save listener would mirror to disk: the body on a doc-change OR
 * a decision transaction, else null (listener bailed). Uses the real isDecisionTx. */
function savedBodyFor(u: { docChanged: boolean; transactions: readonly Transaction[]; state: EditorState }): string | null {
  if (!u.docChanged && !isDecisionTx(u.transactions)) return null
  return stripRanges(u.state.doc.toString(), greenRangesForSave(u.state))
}

describe('in-buffer review — save mirror on accept', () => {
  it('auto-accepting a pure-insertion (empty red) re-mirrors the append into the saved body', () => {
    let saved: string | null = 'ORIGINAL' // seed = the on-disk body before the proposal
    const v = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'ORIGINAL',
        extensions: [
          _matField,
          history(),
          EditorView.updateListener.of((u) => {
            const body = savedBodyFor(u)
            if (body !== null) saved = body
          }),
        ],
      }),
    })

    // Materialize: INSERT green "\nAPPENDED" under the original (this IS a doc
    // change, exactly as the reconciler's INSERT step does), and record the mat —
    // empty red at end of original [8,8], green "APPENDED" at [9,17].
    v.dispatch({
      changes: { from: 8, insert: '\nAPPENDED' },
      effects: _setMat.of([
        { changeId: 'c1', hunks: [{ redFrom: 8, redTo: 8, greenFrom: 9, greenTo: 17, kind: 'add' }] },
      ]),
    })
    // Save excludes pending green while the proposal is live.
    expect(saved).toBe('ORIGINAL\n')

    // Accept: red is EMPTY so there are NO deletions — the dispatch has no doc
    // change, only the drop + acceptEffect. This is the exact transaction shape
    // that used to be dropped by the `!docChanged` bail.
    v.dispatch({ effects: [_dropChange.of('c1'), _acceptEffect.of('c1')] })

    // The fix: the decision transaction re-mirrored, so the append is now saved.
    expect(saved).toBe('ORIGINAL\nAPPENDED')
    v.destroy()
  })
})
