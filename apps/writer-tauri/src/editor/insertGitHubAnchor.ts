// Insert a GitHub-activity card. It's a plain ```github-activity fenced
// code block (a code_block node with language=github-activity) — the same
// wiring as ```mermaid / ```artifact, rendered live by CodeBlockVizNodeView.
// On disk it round-trips as a normal fence; the card body reads events.db
// for the date in its text content.

import type { EditorView } from '@milkdown/kit/prose/view'
import { insertBlockAtSelection } from './insertBlock'

const LANG = 'github-activity'

/** True if the doc already has a github-activity fence for `date`. */
export function hasGitHubAnchor(view: EditorView, date: string): boolean {
  let found = false
  view.state.doc.descendants((node) => {
    if (
      node.type.name === 'code_block' &&
      node.attrs.language === LANG &&
      node.textContent.trim() === date
    ) {
      found = true
    }
  })
  return found
}

/** Insert a ```github-activity fence for `date` at the cursor, unless one
 * already exists for that date. Lands the cursor on the next line. */
export function insertGitHubAnchor(view: EditorView, date: string): void {
  const type = view.state.schema.nodes.code_block
  if (!type || !date) return
  if (hasGitHubAnchor(view, date)) return
  insertBlockAtSelection(
    view,
    type.create({ language: LANG }, view.state.schema.text(date)),
  )
}
