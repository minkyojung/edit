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

import * as Y from 'yjs'
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
import {
  replaceMarkdownInYDoc,
  seedMarkdownIntoYDoc,
} from '@/lib/seedMarkdown'
import { deriveLabel } from '@/lib/docLabel'

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

  // Active-doc happy path: the live PM view + serializer give the
  // most accurate body (markdown is regenerated from the doc the
  // user can actually see). Inactive handles fall through to null
  // until 4.B.1.b.iii lands a fragment-based fallback.
  const isActive = getActiveSlugFromHash() === slug
  if (!isActive) return null

  const { view, serializer } = useEditorViewStore.getState()
  if (!view || !serializer) return null

  let md: string
  try {
    md = serializer(view.state.doc)
  } catch (err) {
    console.warn('[docFileSync] serializer failed for slug', slug, err)
    return null
  }

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
 * removes observers and clears the slug from `dirtySlugs` — closeDoc
 * should call it so a torn-down handle's leftover dirty flag doesn't
 * trigger a flush against a destroyed ydoc.
 *
 * Observes the body fragment for changes that should trigger a save.
 * The marks Y.Map observer that used to live alongside this hook went
 * away with Phase 6 of the Yjs-removal migration — the mark store
 * had no surviving consumers, and PM transactions feed the dirty bit
 * directly through `dirtyTrackerPlugin` now. */
export function installDocSync(slug: string, ydoc: Y.Doc): () => void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  const onChange = () => markDirty(slug)
  fragment.observeDeep(onChange)
  // Mark dirty on install so the first flush tick mirrors this doc
  // to disk regardless of whether the user edits it. Without this,
  // a doc the user opens (or that was already open at boot) but
  // never types into would never reach the vault — leaving gaps
  // between what the sidebar shows and what's on disk. Idempotent
  // — clearDirty after the flush completes leaves the doc clean
  // until the next edit. The cost is one write per doc-mount event;
  // overwrite is benign even when the file already matches.
  markDirty(slug)
  return () => {
    fragment.unobserveDeep(onChange)
    dirtySlugs.delete(slug)
  }
}

// ── Auto-flush timer ─────────────────────────────────────────────
//
// Obsidian-style periodic flush: every FLUSH_INTERVAL_MS the timer
// checks `dirtySlugs` and writes the changed docs to the vault.
// This module owns the timer lifecycle so the rest of the app sees
// a simple start/stop API.
//
// The 2000ms interval matches what Obsidian observes in practice
// (~2s periodic flush during continuous typing, per its plugin
// surface). It's the "natural feel" point — short enough that
// power loss won't lose more than a couple of seconds of typing,
// long enough that a fast typist doesn't trigger constant disk
// I/O.

const FLUSH_INTERVAL_MS = 2000
let flushTimerId: number | null = null

/** Read a doc's vault files (`.md` + `.marks.json`) from disk and
 * return them as raw data. Inverse of {@link serializeDocToFiles}
 * — at the data layer, before any Y.Doc / markStore mutation.
 *
 * Returns null when there's no `.md` for this doc — caller treats
 * that as "no on-disk copy yet, fall back to whatever the in-memory
 * source provides" (currently IDB; eventually a fresh empty doc).
 *
 * Sidecar handling:
 *   - missing `.marks.json`  → returns `{md, sidecar: {version: 1, marks: []}}`
 *     (a vault that was edited only by an external markdown-aware
 *     tool wouldn't have our sidecar; this is the graceful path)
 *   - malformed JSON         → same as missing, but logged once
 *   - unsupported version    → same; sidecar evolution will add
 *     a migrate hook here
 *
 * The function is pure read — no Y.Doc, no markStore. Wiring into
 * the doc lifecycle is the next sub-step (4.B.1.c.ii+). */
/** Outcome of {@link applyVaultBodyToYDoc} so callers can react to
 * each reason for not applying. The 'no-handle' case is gone in
 * Step 5 — callers now pass the Y.Doc directly, so a missing handle
 * is a caller-side concern (caller chose not to call). */
export type ApplyVaultOutcome =
  | 'applied'         // body landed in Y.Doc
  | 'no-vault'        // vault not selected; nothing to load from
  | 'no-file'         // .md doesn't exist on disk
  | 'no-parser'       // editor hasn't mounted yet → no markdown parser
  | 'not-empty'       // Y.Doc already has content; refuse to merge

/** Apply a vault doc's persisted state into the given Y.Doc.
 *
 * Two-tier load (Path C Stage 2):
 *
 *   Tier 1 — .ydoc binary. The full Yjs CRDT state including the
 *     XmlFragment (body) AND the Y.Map<Mark> (mark metadata) AND
 *     the RelativePosition anchors. Y.applyUpdate restores everything
 *     in one shot. No text-search anchoring needed — the marks land
 *     on the exact same characters they were anchored to in the
 *     prior session. This is the same mechanism IDB persistence
 *     provided before Path C Step 3b removed it; we now persist to
 *     the vault folder instead.
 *
 *   Tier 2 — .md + .marks.json fallback. Used when the .ydoc file
 *     is absent (legacy notes from before Stage 1, or external tools
 *     creating fresh .md files). Body comes from the markdown parser;
 *     marks must be re-anchored later via {@link restoreMarksFromSidecar}
 *     once the EditorView is mounted.
 *
 * Tier 1 covers the "AI rewrites the body" case automatically —
 * Yjs's CRDT tracks where each mark is relative to surrounding
 * characters, so a body mutation slides the mark with the text
 * rather than orphaning it.
 *
 * Safety: only operates on an EMPTY Y.Doc. If the fragment already
 * has real text we refuse rather than merge — Yjs CRDT would
 * otherwise concatenate.
 *
 * The write uses the 'doc-init' origin (see seedMarkdown.ts) so the
 * UndoManager skips it. We also clear the dirty flag after applying
 * since the observer fires on the fragment change and would
 * otherwise schedule a re-save of identical content. */
export async function applyVaultBodyToYDoc(
  ydoc: Y.Doc,
  slug: string,
  opts: { reload?: boolean } = {},
): Promise<ApplyVaultOutcome> {
  if (!getActiveVaultPath()) return 'no-vault'

  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return 'no-file'
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)

  const fragment = ydoc.getXmlFragment('prosemirror')
  // Initial hydrate: refuse to merge over real text. deriveLabel walks
  // XmlText inserts, so a one-paragraph stub from MilkdownEditor's
  // mount fill counts as "still empty" and we proceed. fragment.length
  // alone would flip to 1 the moment that stub lands and we'd skip
  // every vault load.
  //
  // Reload (vault watcher → external edit): skip the guard — the
  // caller is explicitly asking for the on-disk body to replace what's
  // in memory because someone modified the .md outside the app.
  if (!opts.reload && deriveLabel(fragment).length > 0) return 'not-empty'

  // Yjs-removal migration Phase 2: the `.ydoc` Tier-1 path is gone.
  // Boot and external-reload both seed Y.Doc from the `.md` body,
  // making the markdown file the single durable source of truth.
  // Any doc whose freshest content used to live only in `.ydoc` was
  // back-filled into `.md` by `migrateYdocV2` before bootstrap; from
  // there the markdown round-trip is good enough until Phases 5–7
  // retire the in-memory Y.Doc entirely.
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath || !(await vaultFileExists(mdPath))) return 'no-file'

  let md: string
  try {
    md = await readVaultFile(mdPath)
  } catch (err) {
    console.warn('[vault:load] read md failed for', slug, err)
    return 'no-file'
  }

  const parser = useEditorViewStore.getState().parser
  if (!parser) return 'no-parser'

  // Branch by whether the fragment already holds content. An empty
  // fragment uses seedMarkdownIntoYDoc (single applyUpdate, naturally
  // atomic). A non-empty one needs replaceMarkdownInYDoc so the
  // clear + apply are bundled into one transact — same mount-race
  // reason as Tier 1 above.
  const ok =
    fragment.length > 0
      ? replaceMarkdownInYDoc(ydoc, md, parser)
      : seedMarkdownIntoYDoc(ydoc, md, parser)
  if (!ok) return 'no-parser'

  clearDirty(slug)
  return 'applied'
}

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
export async function flushDirty(): Promise<void> {
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
      await writeVaultFile(mdPath, result.md)
      // Sidecar carries identity (version + slug) plus opt-in context
      // metadata other code paths populate (aiSummary, aiImportance,
      // and any future fields). Read-modify-write so a flush doesn't
      // clobber fields this layer doesn't know about.
      const mergedMeta = await mergeSidecar(metaPath, result.meta)
      await writeVaultFile(metaPath, JSON.stringify(mergedMeta, null, 2))
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
  const applyHandle = async (
    slug?: string,
  ): Promise<ApplyVaultOutcome | 'no-handle'> => {
    const target = slug ?? getActiveSlugFromHash()
    if (!target) return 'no-handle'
    const handle = useDocsStore.getState().handles[target]
    if (!handle) return 'no-handle'
    return applyVaultBodyToYDoc(handle.ydoc, target)
  }
  ;(window as unknown as { __applyVault: typeof applyHandle }).__applyVault = applyHandle
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
      ydocFragmentLength:
        handle?.ydoc.getXmlFragment('prosemirror').length ?? null,
    }
    console.log('[__diagnose]', out)
    return out
  }
  ;(window as unknown as { __diagnose: typeof diagnose }).__diagnose = diagnose
}
