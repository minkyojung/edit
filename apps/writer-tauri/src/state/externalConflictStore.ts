// External-edit conflict registry.
//
// vaultWatcher hits this when it detects an external write to a slug
// that still has unsaved local edits (`isDirty(slug) === true`).
// Behaviour while a slug is in conflict:
//
//   - `docFileSync.flushDirty` skips it (see the `hasExternalConflict`
//     gate). Without this, the next auto-flush would write the local
//     body to disk and silently overwrite the external version.
//   - `notify.externalEditConflict` surfaces a NON-dismissible toast
//     (vaultWatcher.handleExternalReload) with two resolutions:
//       Reopen  → `reloadFromVault` discards the local body and
//                 re-reads the disk file. User chose external.
//       Dismiss → just clears the conflict. The next auto-flush then
//                 writes the local body, overwriting the external
//                 edit. User chose local.
//
// One slug at a time per conflict. A second external edit on the same
// slug while the toast is up is a no-op (already marked).
//
// Cleared in exactly three places: the two toast actions above, and
// `closeDoc` / `removeKnownDoc` (docsStore) — closing or deleting the
// doc ends the editing session, so a lingering conflict must not gate
// a future reopen. The toast is non-dismissible precisely because it
// is the only IN-SESSION clear; a swipe-away would otherwise latch the
// flush gate silently for the rest of the session.

import { create } from 'zustand'

interface State {
  conflicts: Set<string>
  markConflict: (slug: string) => void
  resolveConflict: (slug: string) => void
  hasConflict: (slug: string) => boolean
}

export const useExternalConflictStore = create<State>((set, get) => ({
  conflicts: new Set(),
  markConflict: (slug) => {
    if (get().conflicts.has(slug)) return
    set((s) => {
      const next = new Set(s.conflicts)
      next.add(slug)
      return { conflicts: next }
    })
    console.warn('[vault:conflict] external edit detected on dirty slug', { slug })
  },
  resolveConflict: (slug) => {
    if (!get().conflicts.has(slug)) return
    set((s) => {
      const next = new Set(s.conflicts)
      next.delete(slug)
      return { conflicts: next }
    })
  },
  hasConflict: (slug) => get().conflicts.has(slug),
}))

/** Non-hook accessor for code paths that can't subscribe (the flush
 * loop, watchers). Reads the live set; safe to call from any module. */
export function hasExternalConflict(slug: string): boolean {
  return useExternalConflictStore.getState().conflicts.has(slug)
}
