// Shared insertion for the GitHub-activity anchor, used by both the
// `/github` slash command and the daily auto-insert effect. Idempotent:
// a given day gets at most one card.

import type { EditorView } from '@milkdown/kit/prose/view'
import { insertBlockAtSelection } from './insertBlock'

/** True if the doc already contains a githubActivity anchor for `date`. */
export function hasGitHubAnchor(view: EditorView, date: string): boolean {
  let found = false
  view.state.doc.descendants((node) => {
    if (node.type.name === 'githubActivity' && node.attrs.date === date) {
      found = true
    }
  })
  return found
}

/** Insert a GitHub-activity anchor for `date` at the cursor, unless one
 * for that date already exists. Lands the cursor on the next line. */
export function insertGitHubAnchor(view: EditorView, date: string): void {
  const type = view.state.schema.nodes.githubActivity
  if (!type) return
  if (hasGitHubAnchor(view, date)) return
  insertBlockAtSelection(view, type.create({ date }))
}
