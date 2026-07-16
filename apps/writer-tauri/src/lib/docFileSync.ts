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
import { pullActiveCmBody } from '@/state/activeCmEditor'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { invalidateWikiIndex } from '@/state/wikiIndex'
import { invalidateVaultTimeline } from '@/state/vaultTimeline'
import { hasExternalConflict } from '@/state/externalConflictStore'
import {
  metaPathForDoc,
  portableFrontmatterFields,
  pathForDoc,
  usesFrontmatter,
  type DocMetaFile,
} from '@/lib/docPaths'
import { mergeFrontmatter } from '@/lib/frontmatter'
import {
  readVaultFile,
  renameVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { notify } from '@/lib/notify'
import { useSaveFailureStore, type SaveFailureCause } from '@/state/saveFailureStore'

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

  // PULL the body from the live CM editor if one is mounted for this slug — CM's
  // state is the authoritative document (see the CM6 guide), so we read it on demand
  // at flush time instead of the editor mirroring it into `handle.bodyMarkdown` on
  // every keystroke. When no editor is mounted (the user navigated away), fall back
  // to the cached `bodyMarkdown`, which the editor's unmount checkpoint refreshed
  // before tearing down — so a slug dirtied moments before navigation still flushes
  // the correct final body.
  const pulled = pullActiveCmBody(slug)
  if (pulled !== null) handle.bodyMarkdown = pulled
  const md = handle.bodyMarkdown

  const known = docs.knownDocs.find((d) => d.slug === slug)
  const meta = buildMetaForKnownDoc(slug, known)
  return { md, meta }
}

/** Compose the sidecar payload from the in-memory `KnownDoc`. Shared
 * between the full-flush path (`serializeDocToFiles`) and the
 * meta-only path (`flushDirty` for docs whose handle has been torn
 * down). */
function buildMetaForKnownDoc(
  slug: string,
  known: KnownDoc | undefined,
): DocMetaFile {
  return {
    version: 1,
    slug,
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
    // YouTube capture metadata (type 'youtube'). Re-emitted each flush so
    // the frontmatter writer embeds it; undefined elsewhere.
    videoId: known?.videoId,
    durationSec: known?.durationSec,
    thumbnailUrl: known?.thumbnailUrl,
    description: known?.description,
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

// Monotonic per-slug edit counter, bumped on every markDirty. The flush loop
// captures a slug's generation BEFORE it serializes the body, then — after the
// awaited disk write — only clears the dirty bit if the generation is
// unchanged. Without this, an edit that lands during the write window (the
// several ms of awaited rename/stat/read/write between serialize and clear)
// has its freshly-set dirty bit wiped by the flush's clearDirty, and is
// silently never written until some later, unrelated edit re-dirties the slug.
const dirtyGeneration = new Map<string, number>()

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

/** A2 hardening — stale-path write guard. True when a flush must DEFER
 * writing a doc's body because its on-disk file vanished from the path
 * the catalog still points at: an external move/rename (or delete) landed
 * in the narrow window between the OS moving the file and the watcher
 * updating `relPath`. Writing then would recreate a zombie at the stale
 * path (move) or resurrect a deleted file (delete) — and strand the live
 * edits there. Deferring keeps the slug dirty; the next tick lands
 * correctly once the watcher settles (relPath swapped → rename-on-change
 * moves the file; or doc torn down → nothing to flush).
 *
 * Scoped to the no-rename case (`lastWritten === mdPath`): when the
 * catalog path already changed, the rename-on-change branch handles the
 * moved file safely, and a brand-new doc (no `lastWritten`) must still
 * create its file. Timing-independent — depends only on disk truth, not
 * on whether the flush beat the watcher. */
export function shouldDeferStaleWrite(
  lastWritten: string | undefined,
  mdPath: string,
  fileExists: boolean,
): boolean {
  return lastWritten === mdPath && !fileExists
}

function markDirty(slug: string): void {
  dirtySlugs.add(slug)
  dirtyGeneration.set(slug, (dirtyGeneration.get(slug) ?? 0) + 1)
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
  dirtyGeneration.delete(slug)
}

/** Capture `slug`'s current edit generation. The flush loop calls this right
 * before it serializes the body, then passes the result to
 * `clearDirtyIfUnchanged` after the awaited write. */
export function captureDirtyGeneration(slug: string): number {
  return dirtyGeneration.get(slug) ?? 0
}

/** Clear `slug`'s dirty bit ONLY if no new edit landed since `gen` was
 * captured. If an edit arrived during the flush's write window the generation
 * advanced — leave the slug dirty so the next tick flushes the newer content
 * instead of dropping it. */
export function clearDirtyIfUnchanged(slug: string, gen: number): void {
  if ((dirtyGeneration.get(slug) ?? 0) === gen) clearDirty(slug)
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
/** Best-effort classification of a vault write error into an actionable
 * cause. Tauri's fs plugin surfaces OS errors as strings, so match on the
 * common substrings and fall back to 'unknown' (still actionable copy). */
function classifySaveError(err: unknown): SaveFailureCause {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  if (msg.includes('no space') || msg.includes('enospc')) return 'disk-full'
  if (
    msg.includes('permission denied') ||
    msg.includes('eacces') ||
    msg.includes('read-only') ||
    msg.includes('erofs')
  )
    return 'permission'
  if (
    msg.includes('no such file') ||
    msg.includes('not found') ||
    msg.includes('enoent') ||
    msg.includes('cannot find') ||
    msg.includes('not allowed') // tauri fs scope / vanished parent dir
  )
    return 'unreachable'
  return 'unknown'
}

/** Record a failed vault write. Surfacing is the reconciler's job (below);
 * this only mutates state. Transient blips stay silent — a slug that
 * recovers or is removed leaves the dirty set and gets pruned by the
 * end-of-pass `reconcile`, so it never reaches the persistence threshold. */
function reportSaveFailure(slug: string, err: unknown): void {
  useSaveFailureStore.getState().recordFailure(slug, classifySaveError(err))
}

// ── Save-failure toast: one declarative reconciler ───────────────────
// The store is the single source of truth; this subscription maps its
// state onto the toast (show / update-copy / dismiss). Level-triggered, so
// the copy always follows the current worst cause (#8) and the toast
// clears the instant the last persistent failure resolves. A signature
// guard makes redundant store ticks no-ops. The toast is non-dismissible
// while active (see notify.saveFailed), so a user can't swipe away a live
// data-loss warning and end up editing into a void (#1). Registered once
// for the app's lifetime — the store is a session singleton.
let saveToastCause: SaveFailureCause | null = null
function reconcileSaveToast(): void {
  const store = useSaveFailureStore.getState()
  const cause = store.hasPersistentFailure() ? store.worstCause() : null
  if (cause === saveToastCause) return
  saveToastCause = cause
  if (cause) notify.saveFailed(cause, { onRetry: () => void flushDirty() })
  else notify.saveFailedResolved()
}
useSaveFailureStore.subscribe(reconcileSaveToast)

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
  // Track whether this flush touched any page the vault index catalogs so
  // we can invalidate the index cache once at the end rather than per-doc.
  // The index maps the WHOLE vault (every folder), so any note change —
  // wiki, daily, a generic note in an imported folder — shifts a row's
  // summary / backlink columns or the catalog itself. Only `system:*`
  // pages are excluded: the index page and its siblings are host-owned
  // and never appear in their own catalog, so their writes must not
  // re-trigger a rebuild (that would loop).
  let indexTouched = false
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
      // Frontmatter docs keep their metadata inside the `.md`; without a
      // handle we can't re-serialise the body to re-embed it, and writing
      // a `.meta.json` here would mint a spurious sidecar the loader would
      // then prefer over the frontmatter. Skip — a frontmatter doc's
      // soft-state is persisted while it's open, by the body flush below
      // that embeds it in the frontmatter block.
      if (usesFrontmatter(known)) {
        // Frontmatter docs keep their metadata inside the `.md`; with the
        // handle gone we can't re-serialise the body, and there's no
        // app-private soft state left to persist separately. Nothing to do.
        clearDirty(slug)
        continue
      }
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
        reportSaveFailure(slug, err)
        // Leave dirty so the next tick retries.
      }
      continue
    }
    // Capture the edit generation before serializing so a mid-write edit
    // (below, across the awaited disk ops) isn't cleared by the final
    // clearDirty — see clearDirtyIfUnchanged.
    const gen = captureDirtyGeneration(slug)
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
      const frontmatterDoc = usesFrontmatter(known)
      const oldMd = lastWrittenPath.get(slug)
      if (oldMd && oldMd !== mdPath) {
        if (await vaultFileExists(oldMd)) {
          await renameVaultFile(oldMd, mdPath)
        }
        // Only sidecar-backed docs have a `.meta.json` to move alongside;
        // frontmatter docs carry their metadata inside the renamed `.md`.
        if (!frontmatterDoc) {
          const oldMeta = oldMd.replace(/\.md$/, '.meta.json')
          if (await vaultFileExists(oldMeta)) {
            await renameVaultFile(oldMeta, metaPath)
          }
        }
      }
      // A2 hardening — stale-path guard. When the catalog still points at
      // the last-written path (no rename intended above) but that file has
      // vanished, an external move/delete is mid-flight (OS moved the file
      // out before the watcher updated relPath). A blind write here would
      // recreate a zombie at the stale path and strand the live edits.
      // Defer: leave the slug dirty so the next tick lands at the right
      // path once the watcher settles. The `oldMd === mdPath` gate scopes
      // the existence stat to the no-rename case (the rename-on-change
      // branch above already handles a moved file when the path changed),
      // so we don't pay a syscall on every rename flush; shouldDeferStaleWrite
      // is the authoritative rule.
      if (oldMd === mdPath) {
        const exists = await vaultFileExists(mdPath)
        if (shouldDeferStaleWrite(oldMd, mdPath, exists)) {
          console.warn(
            '[vault:flush] body target missing — deferring (external move/delete in flight)',
            { slug, mdPath },
          )
          continue
        }
      }
      // Frontmatter-native docs embed their metadata at the top of the
      // `.md`; every other type writes a plain body + a `.meta.json`
      // sidecar. `result.md` is already body-only for frontmatter docs
      // (the loader strips the block on read), so re-attaching here
      // round-trips cleanly instead of doubling the block.
      // Host-managed DocMeta fields (slug/type/…). For frontmatter docs we also
      // PRESERVE any custom keys the DocMeta shape doesn't cover — config docs
      // (skills / commands / agents) keep meaningful frontmatter like
      // `name` / `description` / `model` there, and stripping it on every save
      // would silently erase the user's role metadata.
      let fileContent: string
      if (frontmatterDoc) {
        // Overlay the app's own fields while preserving every other key in
        // the existing block verbatim — lists, nested maps, comments the
        // flat scalar view can't represent. Byte-identical to the old
        // split→compose path for app-authored files, so the equality guard
        // below still short-circuits untouched docs.
        let existing = ''
        try {
          existing = await readVaultFile(mdPath)
        } catch {
          // New file or unreadable — nothing to preserve.
        }
        fileContent = mergeFrontmatter(
          existing,
          portableFrontmatterFields(result.meta),
          result.md,
        )
      } else {
        fileContent = result.md
      }
      // Skip the write when the serialized output is byte-identical to
      // what's already on disk. Opening a doc marks it dirty
      // (installDocSync) even when the user never edits it; without this
      // guard the flush rewrites untouched docs, which surfaces them as
      // phantom changes in the review panel / git. Reading the file back
      // is cheap — flush only runs for the small dirty set, and a slug
      // clears its dirty bit after one flush. Defensive on read errors:
      // fall through to writing so a transient read never strands an edit.
      if (!(await fileContentEquals(mdPath, fileContent))) {
        await writeVaultFile(mdPath, fileContent)
      }
      // Slug is an ephemeral per-boot handle — persisted nowhere (identity
      // across restarts is the file path). Nothing to write beyond the `.md`.
      if (!frontmatterDoc) {
        // Sidecar carries identity (version + slug) plus opt-in context
        // metadata other code paths populate (aiSummary, aiImportance,
        // and any future fields). Read-modify-write so a flush doesn't
        // clobber fields this layer doesn't know about.
        const mergedMeta = await mergeSidecar(metaPath, result.meta)
        const metaJson = JSON.stringify(mergedMeta, null, 2)
        if (!(await fileContentEquals(metaPath, metaJson))) {
          await writeVaultFile(metaPath, metaJson)
        }
      }
      lastWrittenPath.set(slug, mdPath)
      // Only clear if no edit landed during the awaited write above; otherwise
      // leave dirty so the next tick flushes the newer body (not a silent drop).
      clearDirtyIfUnchanged(slug, gen)
      if (!known.type.startsWith('system:')) indexTouched = true
    } catch (err) {
      // Error (not warn) — this is a data-durability failure path.
      // The slug stays dirty so the next auto-flush tick retries,
      // but at quit time the in-memory edits since the last
      // successful flush would be lost. Bumping the level so it
      // shows in red in the dev console and any future telemetry
      // pipeline can filter on it.
      console.error('[vault:flush] write failed for', slug, err)
      reportSaveFailure(slug, err)
      // Leave dirty so the next tick retries.
    }
  }
  // Prune failure entries for every slug that left the dirty set this pass
  // (saved, deleted, archived, handle torn down). This is the single
  // success/cleanup path — keeping `failures ⊆ dirty` — so a recovered or
  // removed slug can never strand a stale entry, and the toast reconciler
  // dismisses the moment the last persistent failure clears.
  useSaveFailureStore.getState().reconcile(getDirtySlugs())
  if (indexTouched) {
    invalidateWikiIndex()
    // Timeline keys on creation date + title, which a body edit doesn't
    // change — but create/rename land here too, so invalidate alongside
    // the index; the timeline persist guards the redundant write.
    invalidateVaultTimeline()
  }
}

/** Checkpoint flush on window blur / hide. The 500 ms timer is the
 * steady-state safety net; these events catch the "user tabbed away to
 * another app / minimised" moments so unsaved edits land immediately
 * instead of waiting for the next tick (the Obsidian "flush on focus
 * loss" behaviour). Fire-and-forget — the single-flight guard
 * serialises them against the timer, and the no-op skip makes an
 * already-clean flush free. */
function onWindowBlur(): void {
  void flushDirty()
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') void flushDirty()
}

/** Begin the periodic flush loop. Idempotent — calling twice is a
 * no-op so multiple boot paths can call it without coordination. */
export function startAutoFlush(): void {
  if (flushTimerId !== null) return
  flushTimerId = window.setInterval(() => {
    void flushDirty()
  }, FLUSH_INTERVAL_MS)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

/** Stop the periodic flush loop. Idempotent. Called on app teardown
 * (Tauri ExitRequested) so the timer doesn't leak into a closing
 * window. CloseConfirmDialog drives a final `flushDirty()` before
 * calling this so unsaved dirty slugs land on disk before exit. */
export function stopAutoFlush(): void {
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
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
  // can be traced back to "slug mismatch" vs "no handle" without
  // sprinkling console.logs into the slice.
  const diagnose = () => {
    const slug = getActiveSlugFromHash()
    const handle = slug ? useDocsStore.getState().handles[slug] : null
    const out = {
      activeSlug: slug,
      hasHandle: Boolean(handle),
      bodyMarkdownLength: handle?.bodyMarkdown?.length ?? null,
      bodyMarkdownPreview:
        handle?.bodyMarkdown?.slice(0, 120) ?? null,
    }
    console.log('[__diagnose]', out)
    return out
  }
  ;(window as unknown as { __diagnose: typeof diagnose }).__diagnose = diagnose
}
