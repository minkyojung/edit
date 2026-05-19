// Doc ↔ vault file synchronisation.
//
// Phase 4.B turns this layer into the bridge between the live Y.Doc
// (memory + IDB today, becoming memory + file in 4.B.1) and the
// markdown + sidecar pair on disk. The runtime flow grows in stages:
//
//   4.B.1.b.i   — serializeDocToFiles for the simple case: active
//                 doc, no marks. Pure read; no disk I/O.
//   4.B.1.b.ii (this commit) — populate the sidecar by extracting
//                 marks from markStore and computing semantic anchors
//                 (quote + context + occurrence) against the serialised
//                 markdown. Mirrors the markResolver fallback chain so
//                 saves and loads stay symmetric.
//   4.B.1.b.iii — handle inactive docs (fragment fallback or
//                 transient PM reconstruction).
//   4.B.1.b.iv  — install observer + debounced atomic write on
//                 Y.Doc changes.
//
// Splitting this way lets each step be inspected in DevTools before
// the next layer goes in: serialize once, see the output, decide
// whether the markdown / sidecar shape is right before wiring
// auto-save on top.

import * as Y from 'yjs'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { invalidateWikiIndex } from '@/state/wikiIndex'
import { markStore } from '@/domain/markStoreInstance'
import type { Mark } from '@/domain/marks'
import {
  metaPathForDoc,
  pathForDoc,
  ydocPathForDoc,
  type DocMetaFile,
} from '@/lib/docPaths'
import {
  readVaultBinary,
  readVaultFile,
  renameVaultFile,
  vaultFileExists,
  writeVaultBinary,
  writeVaultFile,
} from '@/lib/vault'
import { getActiveVaultPath } from '@/state/settingsStore'
import { seedMarkdownIntoYDoc } from '@/lib/seedMarkdown'
import { deriveLabel } from '@/lib/docLabel'

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
  const isActive = docs.activeSlug === slug
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

  const meta: DocMetaFile = { version: 1, slug }
  return { md, meta }
}

// ── Dirty tracking ───────────────────────────────────────────────
//
// Each open doc's Y.Doc gets an observer that marks the slug "dirty"
// on any content or mark mutation. A future auto-flush tick (Phase
// 4.B.1.b.iv.2-3) walks `dirtySlugs` periodically and writes the
// changed docs to vault files.
//
// This sub-phase (iv.1) installs only the observers and the set —
// no disk I/O yet, so we can verify the dirty signal in DevTools
// before wiring the actual flush.

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
 * Observes both the body fragment (text edits, paste, ingest insert)
 * and the marks map (suggestion add / accept / reject); either kind
 * of change should produce a save. */
export function installDocSync(slug: string, ydoc: Y.Doc): () => void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  const marksMap = ydoc.getMap('marks')
  const onChange = () => markDirty(slug)
  fragment.observeDeep(onChange)
  marksMap.observe(onChange)
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
    marksMap.unobserve(onChange)
    dirtySlugs.delete(slug)
  }
}

// ── Auto-flush timer ─────────────────────────────────────────────
//
// Obsidian-style periodic flush: every FLUSH_INTERVAL_MS the timer
// checks `dirtySlugs` and (in a later sub-phase) writes the changed
// docs to the vault. This module owns the timer lifecycle so the
// rest of the app sees a simple start/stop API.
//
// In this sub-phase (iv.2) the timer body is a dummy console log —
// we want to verify the cadence first, then replace the callback
// with the real serialize-and-write pipeline in iv.3.
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

  // Tier 1 — try .ydoc binary first. Brings body + marks +
  // RelativePosition anchors in one Y.applyUpdate. y-prosemirror
  // syncs the marks into PM automatically on editor mount since
  // they're attributes on text nodes in the XmlFragment.
  //
  // On reload we skip this tier: the .ydoc on disk reflects the last
  // app-side flush (i.e. the OLD body), so applying it would either
  // be a no-op (CRDT recognises the state it already has) or — worse
  // — overwrite the external edit with the stale state. The external
  // .md is the only source that knows about the change, so we go
  // straight to Tier 2.
  const ydocPath = ydocPathForDoc(known, getDoc)
  if (!opts.reload && ydocPath && (await vaultFileExists(ydocPath))) {
    try {
      const binary = await readVaultBinary(ydocPath)
      if (fragment.length > 0) {
        ydoc.transact(() => {
          fragment.delete(0, fragment.length)
        }, 'doc-init')
      }
      Y.applyUpdate(ydoc, binary, 'doc-init')
      clearDirty(slug)
      return 'applied'
    } catch (err) {
      // Corrupted .ydoc or schema mismatch — fall through to the
      // markdown tier so the doc still opens with the body the
      // user can see.
      console.warn(
        '[vault:load] .ydoc apply failed, falling back to .md',
        slug,
        err,
      )
    }
  }

  // Tier 2 — markdown-only path. Used when no .ydoc exists yet
  // (externally-created .md, or first session after a vault wipe).
  // Marks aren't restored — the .marks.json legacy path was removed
  // in Stage 3.2. New marks the user creates will be persisted in
  // .ydoc on the next flush.
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

  if (fragment.length > 0) {
    ydoc.transact(() => {
      fragment.delete(0, fragment.length)
    }, 'doc-init')
  }

  const ok = seedMarkdownIntoYDoc(ydoc, md, parser)
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
    const known = docs.knownDocs.find((d) => d.slug === slug)
    if (!known) {
      clearDirty(slug)
      continue
    }
    const mdPath = pathForDoc(known, getDoc)
    const metaPath = metaPathForDoc(known, getDoc)
    const ydocPath = ydocPathForDoc(known, getDoc)
    if (!mdPath || !metaPath || !ydocPath) {
      clearDirty(slug)
      continue
    }
    const result = serializeDocToFiles(slug)
    if (!result) continue
    // Y.Doc binary snapshot — captures the full CRDT state including
    // RelativePosition mark anchors. The handle's ydoc is the live
    // in-memory copy.
    const handle = docs.handles[slug]
    const ydocBinary = handle ? Y.encodeStateAsUpdate(handle.ydoc) : null
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
        const oldYdoc = oldMd.replace(/\.md$/, '.ydoc')
        if (await vaultFileExists(oldMd)) {
          await renameVaultFile(oldMd, mdPath)
        }
        if (await vaultFileExists(oldMeta)) {
          await renameVaultFile(oldMeta, metaPath)
        }
        if (await vaultFileExists(oldYdoc)) {
          await renameVaultFile(oldYdoc, ydocPath)
        }
      }
      await writeVaultFile(mdPath, result.md)
      await writeVaultFile(metaPath, JSON.stringify(result.meta, null, 2))
      if (ydocBinary) {
        await writeVaultBinary(ydocPath, ydocBinary)
      }
      lastWrittenPath.set(slug, mdPath)
      clearDirty(slug)
      if (known.type.startsWith('wiki:')) wikiTouched = true
    } catch (err) {
      console.warn('[vault:flush] write failed for', slug, err)
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
 * window. iv.4 will also drive a final synchronous flush from this
 * path so unsaved dirty slugs land on disk before exit. */
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
//   __listMarks()                  // mark store state of active doc
if (import.meta.env.DEV) {
  const handle = (slug?: string): SerializedDocFiles | null => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return null
    return serializeDocToFiles(target)
  }
  const listMarks = (slug?: string): Mark[] => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return []
    return markStore.list(target)
  }
  ;(window as unknown as {
    __serializeDoc: typeof handle
    __listMarks: typeof listMarks
  }).__serializeDoc = handle
  ;(window as unknown as { __listMarks: typeof listMarks }).__listMarks = listMarks
  ;(window as unknown as { __dirtySlugs: () => string[] }).__dirtySlugs = getDirtySlugs
  const applyHandle = async (
    slug?: string,
  ): Promise<ApplyVaultOutcome | 'no-handle'> => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return 'no-handle'
    const handle = useDocsStore.getState().handles[target]
    if (!handle) return 'no-handle'
    return applyVaultBodyToYDoc(handle.ydoc, target)
  }
  ;(window as unknown as { __applyVault: typeof applyHandle }).__applyVault = applyHandle
  ;(window as unknown as { __activeSlug: () => string | null }).__activeSlug = () =>
    useDocsStore.getState().activeSlug
}
