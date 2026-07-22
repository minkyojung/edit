// Bridge for pushing fresh markdown into (and pulling it out of) the mounted
// CodeMirror editor — the single seam between the docsStore body paths and the
// live view.
//
// The docsStore body-replace paths (reloadFromVault / seedDocBody / replaceDocBody)
// must reach an open editor, or an external file edit (vault watcher) or a
// background rewrite wouldn't land in the buffer the user is looking at (a
// DATA-INTEGRITY hole). CmEditor registers a body-setter (+ a body-getter and the
// review/scroll callbacks) here on mount; the store paths go through this registry.
// Only one doc is active at a time, so a single slug-keyed registration suffices.

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
// Is `changeId` currently shown as an in-buffer proposal in this editor? The legacy
// applier asks this so it doesn't ALSO try to apply a change the in-buffer review
// already owns (which only logged a harmless "outdated" warning).
type CmMaterializedQuery = (changeId: string) => boolean
// Read the editor's CURRENT saved-body markdown, on demand. CM's own state is the
// authoritative document (immutable, always current — see the CM6 guide), so the save
// path PULLS this at flush time instead of the editor mirroring it into a parallel
// copy on every keystroke. Returns the body MINUS pending-green proposal text (disk
// only holds accepted content), matching what the old per-keystroke mirror wrote.
type CmBodyReader = () => string

let active: {
  slug: string
  setBody: CmBodySetter
  rejectChange: CmRejecter
  scrollToChange: CmScroller
  isMaterialized: CmMaterializedQuery
  getBody: CmBodyReader
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
  isMaterialized: CmMaterializedQuery,
  getBody: CmBodyReader,
): void {
  active = { slug, setBody, rejectChange, scrollToChange, isMaterialized, getBody }
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

/** True when `changeId` is showing as an in-buffer proposal in the mounted editor
 * for `slug`. The applier skips its own apply for these — the in-buffer review owns
 * the buffer + the save mirror, so a second apply would be redundant (and noisy). */
export function isChangeMaterializedInActiveCm(slug: string, changeId: string): boolean {
  return active?.slug === slug ? active.isMaterialized(changeId) : false
}

/** The current saved-body markdown of the mounted CM editor for `slug`, read straight
 * from its live state — or null when no editor for `slug` is mounted (then the caller
 * uses its cached copy, refreshed by the editor's unmount checkpoint). The flush path
 * calls this so the on-disk write reflects the live document without a per-keystroke
 * mirror. */
export function pullActiveCmBody(slug: string): string | null {
  return active?.slug === slug ? active.getBody() : null
}
