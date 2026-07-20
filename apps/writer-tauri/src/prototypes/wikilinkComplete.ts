// Known-note stub — the DEFAULT for livePreview's `wikilinkKnown` facet, used by dev
// prototypes and headless tests. Production (CmEditor) overrides it via
// `wikilinkKnown.of(isKnownNoteTitle)` with a real docsStore-backed check, so the
// static list here only ever drives the prototype's blue-vs-red wikilink styling.
//
// (The autocomplete-based `[[` completion source that used to live here is gone — the
// live picker is editor/wikilinkMenu.tsx, an owned tooltip. This file kept only the
// stub the facet default still imports.)

// Stand-in for docsStore.knownDocs titles.
export const NOTE_TITLES = ['Daily Standup', 'Project Brasilia', 'Meeting Notes', 'Roadmap', 'Design Spec']

/** Does a note with this title exist? (Real app: docsStore.knownDocs lookup.)
 * Drives broken-link styling. */
export function isKnownNote(title: string): boolean {
  const t = title.trim().toLowerCase()
  return NOTE_TITLES.some((n) => n.toLowerCase() === t)
}
