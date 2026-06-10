// Editor-neutral bridge for pushing fresh markdown into a mounted CodeMirror editor.
//
// The docsStore body-replace paths (reloadFromVault / seedDocBody / replaceDocBody)
// already push markdown into the active ProseMirror view via applyMarkdownToEditor.
// CmEditor doesn't publish a PM view, so those paths would silently skip it — meaning
// an external file edit (vault watcher) or a background rewrite wouldn't reach an open
// CM editor (a DATA-INTEGRITY hole). This tiny registry lets a mounted CM editor
// register a body-setter; the store paths try it before the PM path. Only one doc is
// active at a time, so a single slug-keyed setter suffices (mirrors editorViewStore).

// `changeId` (when set) means this body-set is an ACCEPT of that pending change — the
// bridge tags the transaction so Cmd-Z can reopen it. Absent = external reload / seed
// (not undoable).
type CmBodySetter = (markdown: string, changeId?: string) => void

let active: { slug: string; setBody: CmBodySetter } | null = null

export function registerCmEditor(slug: string, setBody: CmBodySetter): void {
  active = { slug, setBody }
}

export function unregisterCmEditor(slug: string): void {
  if (active?.slug === slug) active = null
}

/** Push markdown into the mounted CM editor for `slug`. Returns true when a CM editor
 * handled it — the caller then SKIPS the ProseMirror dispatch. `changeId` marks an
 * accept (undoable) vs an external reload. */
export function applyMarkdownToActiveCmEditor(slug: string, markdown: string, changeId?: string): boolean {
  if (!active || active.slug !== slug) return false
  active.setBody(markdown, changeId)
  return true
}
