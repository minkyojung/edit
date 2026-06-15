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
// Reject a change INSIDE the CM editor — an effect-only transaction so Cmd-Z can undo
// it (the editor's mark code owns the actual store.reject + history link).
type CmRejecter = (changeId: string) => void
// Scroll the editor to a pending change's location (chat suggestion card → "jump to
// this change in the note"). The editor resolves the offset from the change's anchor.
type CmScroller = (changeId: string) => void

let active: {
  slug: string
  setBody: CmBodySetter
  rejectChange: CmRejecter
  scrollToChange: CmScroller
} | null = null

// A scroll request that arrived before its target editor mounted — the cross-note jump
// case (the card navigates to another note in the same click). The next editor to
// register for this slug consumes it. Only the latest request is kept.
let pendingScroll: { slug: string; changeId: string } | null = null

export function registerCmEditor(
  slug: string,
  setBody: CmBodySetter,
  rejectChange: CmRejecter,
  scrollToChange: CmScroller,
): void {
  active = { slug, setBody, rejectChange, scrollToChange }
  if (pendingScroll?.slug === slug) {
    const { changeId } = pendingScroll
    pendingScroll = null
    // Defer a frame so the freshly-mounted view is laid out before scrolling.
    requestAnimationFrame(() => scrollToChange(changeId))
  }
}

export function unregisterCmEditor(slug: string): void {
  if (active?.slug === slug) active = null
}

/** Scroll note `slug`'s editor to `changeId`. If that editor is already mounted, scroll
 * now; otherwise park the request so it fires when the editor mounts (the caller
 * navigates to the note in the same click). */
export function requestScrollToChange(slug: string, changeId: string): void {
  if (active && active.slug === slug) {
    active.scrollToChange(changeId)
    return
  }
  pendingScroll = { slug, changeId }
}

/** Push markdown into the mounted CM editor for `slug`. Returns true when a CM editor
 * handled it — the caller then SKIPS the ProseMirror dispatch. `changeId` marks an
 * accept (undoable) vs an external reload. */
export function applyMarkdownToActiveCmEditor(slug: string, markdown: string, changeId?: string): boolean {
  if (!active || active.slug !== slug) return false
  active.setBody(markdown, changeId)
  return true
}

/** Reject `changeId` via the mounted CM editor for `slug` (undoable). Returns true when
 * a CM editor handled it — the caller then SKIPS the plain store.reject. */
export function rejectActiveCmChange(slug: string, changeId: string): boolean {
  if (!active || active.slug !== slug) return false
  active.rejectChange(changeId)
  return true
}
