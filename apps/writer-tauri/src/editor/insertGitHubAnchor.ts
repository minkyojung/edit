// Shared insertion for the GitHub-activity anchor, used by both the
// `/github` slash command and the daily auto-insert effect. Idempotent:
// a given day gets at most one card.

import type { EditorView } from '@milkdown/kit/prose/view'
import { insertBlockAtSelection } from './insertBlock'

/** Document positions of every githubActivity anchor for `date`. */
function anchorPositions(view: EditorView, date: string): number[] {
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'githubActivity' && node.attrs.date === date) {
      positions.push(pos)
    }
  })
  return positions
}

/** True if the doc already contains a githubActivity anchor for `date`. */
export function hasGitHubAnchor(view: EditorView, date: string): boolean {
  return anchorPositions(view, date).length > 0
}

/** Converge on exactly one anchor for `date`: insert if missing, delete the
 * extras if duplicated. Idempotent and self-healing — the daily auto-insert
 * can race with hydration (checking before the saved fence is parsed in),
 * so rather than guard the race we just make the end state deterministic.
 * Anchors are app-managed (not user content), so trimming dupes is safe. */
export function ensureSingleGitHubAnchor(view: EditorView, date: string): void {
  const type = view.state.schema.nodes.githubActivity
  if (!type) return
  const positions = anchorPositions(view, date)
  if (positions.length === 1) return

  if (positions.length === 0) {
    // Top of body so the day's activity sits above the writing.
    const tr = view.state.tr.insert(0, type.create({ date }))
    tr.setMeta('addToHistory', false)
    view.dispatch(tr)
    return
  }

  // Keep the first, drop the rest. Delete high→low so earlier positions
  // stay valid as the doc shrinks.
  let tr = view.state.tr
  for (const pos of positions.slice(1).sort((a, b) => b - a)) {
    const node = tr.doc.nodeAt(pos)
    if (node?.type.name === 'githubActivity') {
      tr = tr.delete(pos, pos + node.nodeSize)
    }
  }
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

/** Insert a GitHub-activity anchor for `date` at the cursor, unless one
 * for that date already exists. Lands the cursor on the next line. */
export function insertGitHubAnchor(view: EditorView, date: string): void {
  const type = view.state.schema.nodes.githubActivity
  if (!type) return
  if (hasGitHubAnchor(view, date)) return
  insertBlockAtSelection(view, type.create({ date }))
}
