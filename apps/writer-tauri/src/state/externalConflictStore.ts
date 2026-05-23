// External-edit conflict registry.
//
// vaultWatcher hits this when it detects an external write to a slug
// that still has unsaved local edits (`isDirty(slug) === true`).
// Behaviour while a slug is in conflict:
//
//   - `docFileSync.flushDirty` skips it. Without the gate, the next
//     auto-flush (every ~30s) would write the live Y.Doc to disk and
//     silently overwrite the external version.
//   - `ExternalEditBanner` renders over the editor for the active
//     doc. Two resolutions:
//       Reopen   → `reloadFromVault` discards the local Y.Doc state
//                  and re-reads the disk file. User chose external.
//       Dismiss  → just clears the conflict. Next auto-flush will
//                  write the local Y.Doc, overwriting the external
//                  edit. User chose local.
//
// One slug at a time per conflict. A second external edit on the
// same slug while a banner is up is a no-op (already marked).
// Cleared on slug archive / doc removal via the docsStore action,
// but for v0.0.1 the banner is the canonical resolution surface.

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
