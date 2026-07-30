// Per-artifact change counter: "this file on disk is not the one you rendered".
//
// vaultWatcher publishes (its artifact branch); FileViewer subscribes and uses
// the number to remount the iframe. Nothing here reads the file — the counter is
// only an identity for "which version", so the artifact's bytes keep going
// straight from disk to the webview over the asset protocol and never cross IPC.
//
// WHY A COUNTER AND NOT AN mtime. mtime would be the natural version token, but
// the app cannot read one: `stat` is absent from the fs capability allowlist
// (src-tauri/capabilities/default.json), so using it means widening permissions
// for a value the watcher has already implied by firing. A content hash would
// cost a full read of the artifact per event, which defeats the point above.
//
// Not persisted: a fresh boot re-reads the file anyway, so a remembered revision
// would only be a way to remount once for nothing.

import { create } from 'zustand'

interface State {
  /** Vault-relative path → how many times the watcher has seen it change. */
  revisions: Record<string, number>
  bumpRevision: (rel: string) => void
}

export const useArtifactRevisionStore = create<State>((set) => ({
  revisions: {},
  // Replaces the record rather than mutating it. Mutating in place would leave
  // zustand's reference equal, so no subscriber re-renders and the whole
  // mechanism looks wired but does nothing.
  bumpRevision: (rel) =>
    set((s) => ({ revisions: { ...s.revisions, [rel]: (s.revisions[rel] ?? 0) + 1 } })),
}))

/** Non-hook publisher, for the watcher — it can't subscribe. Mirrors the
 * `hasExternalConflict` accessor next door in externalConflictStore. */
export function bumpArtifactRevision(rel: string): void {
  useArtifactRevisionStore.getState().bumpRevision(rel)
}

/** Current revision of one artifact. 0 until the watcher sees a change, so a
 * never-modified file has a stable key and does not remount. */
export function useArtifactRevision(rel: string): number {
  return useArtifactRevisionStore((s) => s.revisions[rel] ?? 0)
}
