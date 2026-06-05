// Doc ↔ vault file synchronisation.
//
// Bridge between the live Y.Doc (memory) and the on-disk vault files
// (.md body + .meta.json identity sidecar + .ydoc CRDT snapshot).
//
// Runtime flow:
//   - `installDocSync(slug, ydoc)` attaches an observer to the doc's
//     XmlFragment and marks map; any mutation flags the slug dirty
//   - `startAutoFlush()` ticks every FLUSH_INTERVAL_MS; each tick
//     calls `flushDirty()` which serialises every dirty slug and
//     writes the three files atomically
//   - `flushDirty()` is also called from the app-close path
//     (CloseConfirmDialog) so edits made in the last 2s before quit
//     reach disk
//
// vault.ts owns the atomic write + echo flag; vaultWatcher.ts owns
// external-change detection. This module is the glue: when to write,
// and what (serialise) to write.

import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { useEditorViewStore } from '@/state/editorViewStore'
import { invalidateWikiIndex } from '@/state/wikiIndex'
import { hasExternalConflict } from '@/state/externalConflictStore'
import {
  metaPathForDoc,
  pathForDoc,
  type DocMetaFile,
} from '@/lib/docPaths'
import {
  readVaultFile,
  renameVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'

/** Merge `next` over the existing `.meta.json` at `metaPath` so a
 * flush preserves fields this layer doesn't track (aiSummary written
 * by the ingest summary hook, aiImportance, etc.). Falls back to
 * `next` alone when the sidecar is missing or unparseable — same
 * behaviour as the previous full-overwrite, just no longer the
 * default for healthy files.
 *
 * Read-modify-write is safe because the flush loop is the only
 * runtime writer of `<slug>.meta.json` (the other writer is
 * `getOrAssignSlug`, which runs once per file at boot). Each flush
 * tick processes one slug at a time, so no two `mergeSidecar` calls
 * overlap. The invariant matters: a sibling code path that wrote
 * the sidecar outside this loop would race with the next periodic
 * flush, intermittently restoring stale fields (e.g. `archivedAt`
 * snapshots from before an unarchive). Route any new sidecar writes
 * through `markSlugDirty(slug)` + `flushDirty()` instead. */
async function mergeSidecar(
  metaPath: string,
  next: DocMetaFile,
): Promise<DocMetaFile> {
  if (!(await vaultFileExists(metaPath))) return next
  try {
    const raw = await readVaultFile(metaPath)
    const existing = JSON.parse(raw) as Partial<DocMetaFile>
    return { ...existing, ...next }
  } catch {
    // Corrupt sidecar — let the fresh `next` overwrite it; we'd
    // rather lose stale context metadata than block the flush.
    return next
  }
}

/** True when the file at `relPath` exists and its contents exactly
 * equal `content`. Used by the flush to skip no-op writes (a doc that
 * was opened — and thus marked dirty — but whose serialized output
 * matches disk). Returns false on a missing file or any read error so
 * the caller writes; this guard only ever *suppresses* a redundant
 * write, never a needed one. */
async function fileContentEquals(
  relPath: string,
  content: string,
): Promise<boolean> {
  try {
    if (!(await vaultFileExists(relPath))) return false
    return (await readVaultFile(relPath)) === content
  } catch {
    return false
  }
}

/** Result shape of {@link serializeDocToFiles} — the artefacts a
 * flush tick writes to disk for one doc:
 *   - `md`   — clean markdown body, written to `<stem>.md`
 *   - `meta` — slim identity sidecar (slug only), written to
 *              `<stem>.meta.json`
 *
 * Marks are not in this shape anymore — they live in the `.ydoc`
 * binary which flushDirty assembles separately from the handle's
 * Y.Doc. Path C Stage 3 removed the `.marks.json` payload (text-search
 * anchoring) in favor of `.ydoc` (CRDT RelativePosition anchoring). */
export interface SerializedDocFiles {
  md: string
  meta: DocMetaFile
}

/** Serialize one open doc to the on-disk pair `{md, sidecar}`.
 *
 * v1 scope: only the active doc, marks ignored (sidecar is empty).
 * Returns null when the doc isn't open, the view hasn't mounted,
 * or the Milkdown serializer isn't ready yet — callers should
 * treat that as "skip this tick, try again next change" rather
 * than an error.
 *
 * The markdown output is whatever Milkdown's commonmark + gfm
 * serializer produces for the live PM doc. Mark spans currently
 * survive in the output as inline HTML (per `proof-marks.ts`'s
 * toMarkdown runner) — that's fine for this step because we're
 * verifying the body shape, not yet the mark strip. The next step
 * (4.B.1.b.ii) will move mark metadata into the sidecar and produce
 * clean markdown without span clutter. */
export function serializeDocToFiles(slug: string): SerializedDocFiles | null {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return null

  // K-followup safety: never flush when the handle is still loading
  // its initial body from disk. The default `bodyMarkdown` on a fresh
  // handle is the empty string; if anything (a stray PM transaction,
  // an applyToWikiPage call) marks the slug dirty before
  // `ensureHandle`'s disk read resolves, the flush would write that
  // empty string and wipe the disk file. The Daniel.md 0-byte
  // incident traced back to exactly this race. Once `status: 'ready'`
  // flips, bodyMarkdown carries either the hydrated disk content or
  // a real user edit, and the flush proceeds normally.
  const status = docs.status[slug]
  if (status !== 'ready') {
    console.log('[vault:flush] skip — handle still loading', slug, status)
    return null
  }

  // Phase I: read from `handle.bodyMarkdown`, which dirtyTrackerPlugin
  // keeps in sync with the live PM doc on every transaction. This
  // removes the legacy "active doc only" gate: a slug that was
  // dirtied moments before the user navigated away still flushes
  // because the cache survived the editor unmount.
  const md = handle.bodyMarkdown

  // `titleIntent` reflects whether the in-memory title is the user's
  // chosen value or whether `pathForDoc` had to fall back to
  // 'Untitled' because the doc was created without a title. The boot
  // reader uses this flag to decide whether the filename should
  // hydrate back into KnownDoc.title; if 'empty', the title stays
  // undefined and the EditableTitleInput renders its placeholder
  // instead of the literal string "Untitled". Wiki, system, and
  // writing docs all share the same rule so the flush owns it for
  // every type at once.
  const known = docs.knownDocs.find((d) => d.slug === slug)
  const meta = buildMetaForKnownDoc(slug, known)
  return { md, meta }
}

/** Compose the sidecar payload from the in-memory `KnownDoc`. Shared
 * between the full-flush path (`serializeDocToFiles`) and the
 * meta-only path (`flushDirty` for archived docs whose handle has
 * been torn down). Fields included:
 *   - `titleIntent`            — see comment below
 *   - `archivedAt`             — present iff the doc is currently
 *                                archived in memory
 *   - `archivedFromParent`     — same condition
 *
 * `archivedAt`/`archivedFromParent` are emitted explicitly (including
 * the `undefined` case for live docs) so `mergeSidecar` can clear
 * stale archive markers on unarchive: a spread of an `undefined` key
 * over an existing value, then JSON.stringify, drops the field from
 * the on-disk JSON. Without the explicit key the merge would preserve
 * the pre-unarchive value. */
function buildMetaForKnownDoc(
  slug: string,
  known: KnownDoc | undefined,
): DocMetaFile {
  // `titleIntent` reflects whether the in-memory title is the user's
  // chosen value or whether `pathForDoc` had to fall back to
  // 'Untitled' because the doc was created without a title. The boot
  // reader uses this flag to decide whether the filename should
  // hydrate back into KnownDoc.title; if 'empty', the title stays
  // undefined and the EditableTitleInput renders its placeholder
  // instead of the literal string "Untitled". Wiki, system, and
  // writing docs all share the same rule so the flush owns it for
  // every type at once.
  const titleIntent: 'empty' | 'set' = known?.title?.trim() ? 'set' : 'empty'
  return {
    version: 1,
    slug,
    titleIntent,
    archivedAt: known?.archivedAt,
    archivedFromParent: known?.archivedFromParent,
    // Phase 5b of the Yjs-removal migration: createdAt now lives on
    // the catalog (sourced from `.meta.json` by scanVault, or set by
    // createSlice for new docs). flushDirty writes it back via
    // mergeSidecar, so the sidecar is the durable home.
    createdAt: known?.createdAt,
    // Read-it-later article metadata (present only on type 'article').
    // Undefined for every other doc type, so mergeSidecar drops them.
    sourceUrl: known?.sourceUrl,
    siteName: known?.siteName,
    faviconUrl: known?.faviconUrl,
    savedAt: known?.savedAt,
    readAt: known?.readAt,
    // Full highlight set, re-emitted each flush (KnownDoc holds the
    // authoritative array). Undefined for non-articles → mergeSidecar
    // drops the key.
    highlights: known?.highlights,
  }
}

/** Meta-only serialization for docs whose body/CRDT state isn't
 * available (archived docs after handle teardown). Reads the
 * in-memory `KnownDoc` and produces just the sidecar payload —
 * `flushDirty` writes it via the same `mergeSidecar` path the body
 * flush uses, keeping the flush as the single writer of sidecars. */
export function serializeMetaOnly(slug: string): DocMetaFile | null {
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return null
  return buildMetaForKnownDoc(slug, known)
}

// ── Dirty tracking ───────────────────────────────────────────────
//
// Each open doc's Y.Doc gets an observer that marks the slug "dirty"
// on any content or mark mutation. The auto-flush tick walks
// `dirtySlugs` periodically and writes the changed docs to vault files.

const dirtySlugs = new Set<string>()

// Tracks where each slug was last successfully written. Lets the
// flush path detect "the doc's filename changed since last write"
// (e.g. an Untitled note gained a title, a wiki page was renamed)
// and emit a filesystem rename rather than create a new file and
// orphan the old one. Matches the standard pattern in disk-backed
// editors (Obsidian rename, VS Code rename) where the on-disk file
// follows the title through renames instead of multiplying.
//
// Cleared on app reload (in-memory only). That's safe: the next
// flush after reload writes to the current path with no rename
// needed, and rename tracking resumes from there. Stale orphans
// left from pre-rename versions of the app stay where they are
// until the user cleans them — we don't try to retroactively
// reconcile across restarts (would need a vault-wide slug→file
// index, out of scope).
const lastWrittenPath = new Map<string, string>()

/** Seed the rename tracker from the current on-disk state. Called by
 * `scanVault` at boot so the first user rename can detect each doc's
 * existing file and emit `fs.rename` instead of silently writing a
 * new path and leaving the old file behind.
 *
 * Without this, a boot → quick rename sequence races the 2s
 * auto-flush: `lastWrittenPath.get(slug)` returns undefined, the
 * rename-on-change block is skipped, and the disk ends up with two
 * `.md` files claiming the same slug. `scanVault` then picks one of
 * them alphabetically on the next reload, so renames silently revert.
 *
 * Idempotent — overwrites any existing entry. Safe to call multiple
 * times if a reconcile pass needs to resync. */
export function seedLastWrittenPath(
  entries: Array<{ slug: string; mdRel: string }>,
): void {
  for (const { slug, mdRel } of entries) {
    lastWrittenPath.set(slug, mdRel)
  }
}

function markDirty(slug: string): void {
  dirtySlugs.add(slug)
}

/** Public surface for marking a doc dirty without a Y.Doc mutation.
 * Used by knownDocs-only changes (rename) so the next flush picks
 * the slug up and the rename-on-change path moves the file on disk. */
export function markSlugDirty(slug: string): void {
  markDirty(slug)
}

/** Mark `slug` clean — called by the flush tick after a successful
 * write. Exposed for tests and the future flushDirty implementation
 * (iv.3). */
export function clearDirty(slug: string): void {
  dirtySlugs.delete(slug)
}

/** Snapshot of slugs that have unsaved changes since their last
 * successful flush. Returns a copy so callers can iterate while the
 * underlying set mutates from background observers. */
export function getDirtySlugs(): string[] {
  return [...dirtySlugs]
}

/** True iff `slug` has unsaved local edits queued for the next flush
 * tick. Read-only view onto `dirtySlugs` for callers that need to
 * gate side effects (e.g. vault watcher skipping an external-reload
 * when the local copy is dirty) without iterating the whole set. */
export function isDirty(slug: string): boolean {
  return dirtySlugs.has(slug)
}

/** Wire up the dirty tracker for a handle. Returns a disposer that
 * clears the slug from `dirtySlugs` — closeDoc should call it so a
 * torn-down handle's leftover dirty flag doesn't trigger a flush
 * against a slug whose state has gone away.
 *
 * Phase 5c of the Yjs-removal migration retired the Y.Doc fragment
 * observer this helper used to install — PM transactions feed the
 * dirty bit directly through `dirtyTrackerPlugin` now. All this
 * function does is mark the slug dirty once so the first flush tick
 * mirrors a freshly-opened doc to disk regardless of whether the
 * user edits it (covering the "boot tab the user never touches"
 * case). The cost is one write per doc-mount event; overwrite is
 * benign even when the file already matches. */
export function installDocSync(slug: string): () => void {
  markDirty(slug)
  return () => {
    dirtySlugs.delete(slug)
  }
}

// ── Auto-flush timer ─────────────────────────────────────────────
//
// Periodic flush: every FLUSH_INTERVAL_MS the timer checks
// `dirtySlugs` and writes the changed docs to the vault.
//
// Phase I tuned this down from 2000 ms to 500 ms. The previous value
// was inherited from the Yjs era when an IndexedDB autopersist was
// the real safety net and the .md write was just a "also save to
// disk" backup. Yjs is gone; the .md write is now the only
// persistence, so the interval IS the data-loss window on app crash
// or external SIGKILL. 500 ms is short enough that a power loss
// loses at most a sentence, long enough that a fast typist still
// settles between writes.

const FLUSH_INTERVAL_MS = 500
let flushTimerId: number | null = null

/** Single-flight guard. Multiple call sites trigger flushDirty (the
 * 500 ms timer, Editor unmount, the autoflush spinner button). Without
 * coordination two flushes can step on each other inside the
 * `writeVaultFile` atomic-rename window: one creates `.md.tmp`, the
 * other tries to rename a `.md.tmp` that's already been moved away,
 * and the OS surfaces "No such file or directory". We've seen this
 * since the interval shortened to 500 ms in Phase I.
 *
 * Semantics: at most one flush running at a time. A request that
 * arrives during an in-flight flush sets `flushQueued = true` instead
 * of dropping silently — the in-flight pass might have started before
 * the latest mutations were dirty, so we need to come back through
 * once more after it finishes. Repeated requests while queued collapse
 * to a single follow-up. */
let flushInProgress = false
let flushQueued = false

/** Walk dirty slugs once and persist each to its vault file pair.
 * Called from the periodic flush timer. Errors are isolated per
 * slug — a single failed write doesn't block the others — and the
 * slug stays dirty so the next tick retries.
 *
 * Skip conditions (all silent — leave dirty for next tick or clear
 * outright depending on whether the cause is transient):
 *   - vault not selected           → skip all (transient)
 *   - slug no longer in knownDocs  → clear (no point retrying)
 *   - pathForDoc returns null      → clear (doc type has no on-disk
 *                                    placement — e.g. 'writing')
 *   - serializeDocToFiles null     → skip (active not ready,
 *                                    transient — wait for view) */
/** Public flush entry point with single-flight guard. See the
 * `flushInProgress` / `flushQueued` comment above for the contract.
 * The actual work lives in `flushDirtyOnce` below. */
export async function flushDirty(): Promise<void> {
  if (flushInProgress) {
    flushQueued = true
    return
  }
  flushInProgress = true
  try {
    await flushDirtyOnce()
    while (flushQueued) {
      flushQueued = false
      await flushDirtyOnce()
    }
  } finally {
    flushInProgress = false
  }
}

async function flushDirtyOnce(): Promise<void> {
  if (!getActiveVaultPath()) return
  const docs = useDocsStore.getState()
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  // Track whether this flush touched any wiki page so we can invalidate
  // the Tier 1 index cache once at the end rather than per-doc. A wiki
  // body / title change affects the index's summary + backlink columns
  // for both the changed page and any pages it links to.
  let wikiTouched = false
  for (const slug of getDirtySlugs()) {
    // Skip slugs with an unresolved external-edit conflict. Writing
    // the live Y.Doc here would silently overwrite the external
    // version while the user is still deciding via the banner.
    // The slug stays dirty so the next flush after the user picks
    // Dismiss (keep local) will land normally. Picking Reopen
    // clears dirty before reload, so this gate doesn't strand
    // writes either way.
    if (hasExternalConflict(slug)) continue
    const known = docs.knownDocs.find((d) => d.slug === slug)
    if (!known) {
      clearDirty(slug)
      continue
    }
    const mdPath = pathForDoc(known, getDoc)
    const metaPath = metaPathForDoc(known, getDoc)
    if (!mdPath || !metaPath) {
      clearDirty(slug)
      continue
    }
    // Meta-only path: archived docs have had their handles torn down,
    // so the body/CRDT can't be re-serialized. We still need the
    // sidecar to record the archive flag so the state survives boot,
    // so write just the meta and clear dirty. Routing this through
    // the same `mergeSidecar` call the body flush uses keeps the
    // flush as the single writer of sidecars — no concurrent
    // `mergeSidecar` callers means no read-modify-write races.
    const handle = docs.handles[slug]
    if (!handle) {
      const metaOnly = serializeMetaOnly(slug)
      if (!metaOnly) {
        clearDirty(slug)
        continue
      }
      try {
        const merged = await mergeSidecar(metaPath, metaOnly)
        await writeVaultFile(metaPath, JSON.stringify(merged, null, 2))
        clearDirty(slug)
      } catch (err) {
        console.error('[vault:flush] meta-only write failed for', slug, err)
        // Leave dirty so the next tick retries.
      }
      continue
    }
    const result = serializeDocToFiles(slug)
    if (!result) continue
    // Yjs-removal migration Phase 2: the `.ydoc` write path is gone.
    // `.md` is the single durable surface; the in-memory Y.Doc is
    // the working copy for this session only. Phases 5–7 will retire
    // the Y.Doc altogether and switch this flush over to a PM-only
    // serializer.
    try {
      // Rename-on-change: if this slug was last written at a
      // different path (Untitled note gained a title, wiki page
      // renamed, daily child note re-titled), move the existing
      // files to the new path rather than write a fresh copy and
      // orphan the old one. Skipped silently when the old file is
      // already gone.
      const oldMd = lastWrittenPath.get(slug)
      if (oldMd && oldMd !== mdPath) {
        const oldMeta = oldMd.replace(/\.md$/, '.meta.json')
        if (await vaultFileExists(oldMd)) {
          await renameVaultFile(oldMd, mdPath)
        }
        if (await vaultFileExists(oldMeta)) {
          await renameVaultFile(oldMeta, metaPath)
        }
      }
      // Skip the write when the serialized output is byte-identical to
      // what's already on disk. Opening a doc marks it dirty
      // (installDocSync) even when the user never edits it; without this
      // guard the flush rewrites untouched docs, which surfaces them as
      // phantom changes in the review panel / git. Reading the file back
      // is cheap — flush only runs for the small dirty set, and a slug
      // clears its dirty bit after one flush. Defensive on read errors:
      // fall through to writing so a transient read never strands an edit.
      if (!(await fileContentEquals(mdPath, result.md))) {
        await writeVaultFile(mdPath, result.md)
      }
      // Sidecar carries identity (version + slug) plus opt-in context
      // metadata other code paths populate (aiSummary, aiImportance,
      // and any future fields). Read-modify-write so a flush doesn't
      // clobber fields this layer doesn't know about.
      const mergedMeta = await mergeSidecar(metaPath, result.meta)
      const metaJson = JSON.stringify(mergedMeta, null, 2)
      if (!(await fileContentEquals(metaPath, metaJson))) {
        await writeVaultFile(metaPath, metaJson)
      }
      lastWrittenPath.set(slug, mdPath)
      clearDirty(slug)
      if (known.type.startsWith('wiki:')) wikiTouched = true
    } catch (err) {
      // Error (not warn) — this is a data-durability failure path.
      // The slug stays dirty so the next auto-flush tick retries,
      // but at quit time the in-memory edits since the last
      // successful flush would be lost. Bumping the level so it
      // shows in red in the dev console and any future telemetry
      // pipeline can filter on it.
      console.error('[vault:flush] write failed for', slug, err)
      // Leave dirty so the next tick retries.
    }
  }
  if (wikiTouched) invalidateWikiIndex()
}

/** Begin the periodic flush loop. Idempotent — calling twice is a
 * no-op so multiple boot paths can call it without coordination. */
export function startAutoFlush(): void {
  if (flushTimerId !== null) return
  flushTimerId = window.setInterval(() => {
    void flushDirty()
  }, FLUSH_INTERVAL_MS)
}

/** Stop the periodic flush loop. Idempotent. Called on app teardown
 * (Tauri ExitRequested) so the timer doesn't leak into a closing
 * window. CloseConfirmDialog drives a final `flushDirty()` before
 * calling this so unsaved dirty slugs land on disk before exit. */
export function stopAutoFlush(): void {
  if (flushTimerId === null) return
  window.clearInterval(flushTimerId)
  flushTimerId = null
}

// Dev-only console handle. Pass a slug, or omit to use the active
// doc. Returns null when no doc is active or the serializer isn't
// ready yet.
//   __serializeDoc()              // current active doc
//   __serializeDoc('wiki:custom-abc')
if (import.meta.env.DEV) {
  const handle = (slug?: string): SerializedDocFiles | null => {
    const target = slug ?? getActiveSlugFromHash()
    if (!target) return null
    return serializeDocToFiles(target)
  }
  ;(window as unknown as {
    __serializeDoc: typeof handle
  }).__serializeDoc = handle
  ;(window as unknown as { __dirtySlugs: () => string[] }).__dirtySlugs = getDirtySlugs
  ;(window as unknown as { __activeSlug: () => string | null }).__activeSlug = getActiveSlugFromHash
  // Manual trigger for the active-doc body rewrite path. The Yjs-removal
  // migration's Phase 4 swap (PM dispatch when the slug matches the
  // active editor, Y.Doc fallback otherwise) is hard to exercise from
  // the UI alone — no buttons drive `replaceDocBody` directly today.
  // Run `__replaceActive('# new body')` from DevTools to confirm the
  // active editor updates in place.
  const replaceActive = async (markdown: string): Promise<boolean> => {
    const slug = getActiveSlugFromHash()
    if (!slug) return false
    return useDocsStore.getState().replaceDocBody(slug, markdown)
  }
  ;(window as unknown as {
    __replaceActive: typeof replaceActive
  }).__replaceActive = replaceActive
  // Diagnostics for the active-doc body rewrite path. Prints whatever
  // `replaceDocBody` would see right now, so a confused test result
  // can be traced back to "view missing" vs "slug mismatch" vs
  // "parser missing" without sprinkling console.logs into the slice.
  const diagnose = () => {
    const slug = getActiveSlugFromHash()
    const view = useEditorViewStore.getState().view
    const parser = useEditorViewStore.getState().parser
    const handle = slug ? useDocsStore.getState().handles[slug] : null
    const out = {
      activeSlug: slug,
      hasView: Boolean(view),
      hasParser: Boolean(parser),
      hasHandle: Boolean(handle),
      docSize: view?.state.doc.content.size ?? null,
      bodyMarkdownLength: handle?.bodyMarkdown?.length ?? null,
      bodyMarkdownPreview:
        handle?.bodyMarkdown?.slice(0, 120) ?? null,
    }
    console.log('[__diagnose]', out)
    return out
  }
  ;(window as unknown as { __diagnose: typeof diagnose }).__diagnose = diagnose
}
