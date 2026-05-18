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
import { IndexeddbPersistence } from 'y-indexeddb'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { useDocsStore } from '@/state/docsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { markStore } from '@/domain/markStoreInstance'
import { isValidMark, type Mark } from '@/domain/marks'
import { markToSidecar, sidecarToMark } from '@/export/markAdapter'
import type { AnchorSpec, MarkSidecar, MarksSidecarFile } from '@/export/types'
import { findQuoteInDoc } from '@/domain/internal/quote'
import { pathForDoc, sidecarPathForDoc, ydocPathForDoc } from '@/lib/docPaths'
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

/** Result shape of {@link serializeDocToFiles} — the two strings we
 * would write side-by-side to disk (body + sidecar). Mirrors
 * `SerializedDoc` from `export/types.ts` so the data flows straight
 * into the file-write step once that's wired. */
export interface SerializedDocFiles {
  md: string
  sidecar: MarksSidecarFile
}

const CONTEXT_WINDOW = 32

/** Build the semantic anchor for one mark by re-locating its quote
 * inside the serialised markdown. Mirrors prototype-git-storage's
 * resolver so save / load stay symmetric: a sidecar produced here
 * can be re-anchored by markResolver without translation.
 *
 * Strategy
 *   - First occurrence wins (occurrence=0). Same-quote duplicates on
 *     the same page are disambiguated on load via contextBefore /
 *     contextAfter + the recorded occurrence ordinal.
 *   - Returns null when the quote isn't in the body — caller drops
 *     that mark from the sidecar rather than persisting a broken
 *     anchor that would only flag as orphan on every load.
 *
 * v1 limitation: a mark whose quote appears N > 1 times on the page
 * always serialises with occurrence=0. The wrapping flow (next
 * step) will look at the mark's PM range to pick the right
 * occurrence; for the simple sidecar build here it's the first
 * match. */
function buildAnchorForMark(text: string, mark: Mark): AnchorSpec | null {
  if (!mark.quote) return null
  const idx = text.indexOf(mark.quote)
  if (idx === -1) return null
  return {
    quote: mark.quote,
    contextBefore: text.slice(Math.max(0, idx - CONTEXT_WINDOW), idx),
    contextAfter: text.slice(
      idx + mark.quote.length,
      Math.min(text.length, idx + mark.quote.length + CONTEXT_WINDOW),
    ),
    occurrence: 0,
  }
}

/** Pull marks out of markStore and convert them to sidecar entries.
 * Marks that can't be re-anchored against the current body
 * (`buildAnchorForMark` returns null) drop out — they'd be flagged
 * as `orphaned` on load anyway, and quietly skipping them now
 * keeps the sidecar honest about what's on this page right now. */
function buildSidecarMarks(slug: string, md: string): MarkSidecar[] {
  const marks = markStore.list(slug)
  const out: MarkSidecar[] = []
  for (const mark of marks) {
    const anchor = buildAnchorForMark(md, mark)
    if (!anchor) continue
    out.push(markToSidecar(mark, anchor))
  }
  return out
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

  const sidecar: MarksSidecarFile = {
    version: 1,
    slug,
    marks: buildSidecarMarks(slug, md),
  }

  return { md, sidecar }
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
export async function loadDocFromFiles(
  slug: string,
): Promise<SerializedDocFiles | null> {
  if (!getActiveVaultPath()) return null
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return null
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  const sidecarPath = sidecarPathForDoc(known, getDoc)
  if (!mdPath || !sidecarPath) return null

  if (!(await vaultFileExists(mdPath))) return null
  let md: string
  try {
    md = await readVaultFile(mdPath)
  } catch (err) {
    console.warn('[vault:load] read md failed for', slug, err)
    return null
  }

  let sidecar: MarksSidecarFile = { version: 1, marks: [] }
  if (await vaultFileExists(sidecarPath)) {
    try {
      const raw = await readVaultFile(sidecarPath)
      const parsed = JSON.parse(raw) as unknown
      if (isSidecarFile(parsed)) {
        sidecar = parsed
      } else {
        console.warn('[vault:load] sidecar shape unrecognised, ignoring', slug)
      }
    } catch (err) {
      console.warn('[vault:load] sidecar parse failed for', slug, err)
    }
  }

  return { md, sidecar }
}

/** Narrow a JSON.parse result to MarksSidecarFile. Defensive — the
 * file on disk could have been hand-edited or written by an older /
 * future version of the app. */
function isSidecarFile(value: unknown): value is MarksSidecarFile {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<MarksSidecarFile>
  return v.version === 1 && Array.isArray(v.marks)
}

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
): Promise<ApplyVaultOutcome> {
  if (!getActiveVaultPath()) return 'no-vault'

  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return 'no-file'
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)

  const fragment = ydoc.getXmlFragment('prosemirror')
  // Refuse to merge over real text. deriveLabel walks XmlText inserts,
  // so a one-paragraph stub from MilkdownEditor's mount fill counts as
  // "still empty" and we proceed. fragment.length alone would flip to 1
  // the moment that stub lands and we'd skip every vault load.
  if (deriveLabel(fragment).length > 0) return 'not-empty'

  // Tier 1 — try .ydoc binary first. Brings body + marks +
  // RelativePosition anchors in one Y.applyUpdate. y-prosemirror
  // syncs the marks into PM automatically on editor mount since
  // they're attributes on text nodes in the XmlFragment.
  const ydocPath = ydocPathForDoc(known, getDoc)
  if (ydocPath && (await vaultFileExists(ydocPath))) {
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

  // Tier 2 — legacy markdown path. Body only; marks restored later
  // by restoreMarksFromSidecar after view ready.
  const loaded = await loadDocFromFiles(slug)
  if (!loaded) return 'no-file'

  const parser = useEditorViewStore.getState().parser
  if (!parser) return 'no-parser'

  if (fragment.length > 0) {
    ydoc.transact(() => {
      fragment.delete(0, fragment.length)
    }, 'doc-init')
  }

  const ok = seedMarkdownIntoYDoc(ydoc, loaded.md, parser)
  if (!ok) return 'no-parser'

  clearDirty(slug)
  return 'applied'
}

/** Read the sidecar for `slug` and restore every still-anchorable
 * mark into the live EditorView. Called from MilkdownEditor's mount
 * AFTER the editor is created and view is in editorViewStore — by
 * that point the body has been seeded (applyVaultBodyToYDoc ran in
 * buildHandle's contentReady) so quote-based anchor resolution can
 * find the marks in the PM doc.
 *
 * v1 anchor resolution: find the quote in the current PM doc, first
 * match wins (occurrence: 0). Marks whose quote no longer appears in
 * the body drop silently — the body is the source of truth, marks
 * that can't anchor against it are stale. Phase 4.E (file watcher)
 * will promote this to the full markResolver context + occurrence
 * strategy so external edits to the body don't drop marks
 * unnecessarily.
 *
 * Returns the count of marks successfully restored. Zero when:
 *   - vault not selected
 *   - no .marks.json file
 *   - sidecar empty
 *   - none of the recorded quotes survive in the current body */
export async function restoreMarksFromSidecar(
  view: import('@milkdown/kit/prose/view').EditorView,
  slug: string,
): Promise<number> {
  if (!getActiveVaultPath()) return 0
  const loaded = await loadDocFromFiles(slug)
  if (!loaded || loaded.sidecar.marks.length === 0) return 0
  let restored = 0
  for (const sidecarMark of loaded.sidecar.marks) {
    const mark = sidecarToMark(sidecarMark)
    if (!mark) continue
    const anchor = findQuoteInDoc(view, mark.quote)
    if (!anchor) continue
    const ok = await markStore.restore({ slug, mark, anchor })
    if (ok) restored++
  }
  return restored
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
  for (const slug of getDirtySlugs()) {
    const known = docs.knownDocs.find((d) => d.slug === slug)
    if (!known) {
      clearDirty(slug)
      continue
    }
    const mdPath = pathForDoc(known, getDoc)
    const sidecarPath = sidecarPathForDoc(known, getDoc)
    const ydocPath = ydocPathForDoc(known, getDoc)
    if (!mdPath || !sidecarPath || !ydocPath) {
      clearDirty(slug)
      continue
    }
    const result = serializeDocToFiles(slug)
    if (!result) continue
    // Y.Doc binary snapshot — captures the full CRDT state including
    // RelativePosition mark anchors that text-search sidecar can't
    // express. The handle's ydoc is the live in-memory copy that
    // flush serializes from. Stage 1 writes alongside .marks.json;
    // Stage 2 will switch the load path to prefer .ydoc.
    const handle = docs.handles[slug]
    const ydocBinary = handle ? Y.encodeStateAsUpdate(handle.ydoc) : null
    try {
      // Rename-on-change: if this slug was last written at a
      // different path (Untitled note gained a title, wiki page
      // renamed, daily child note re-titled), move the existing
      // files to the new path rather than write a fresh copy and
      // orphan the old one. Standard pattern in disk-backed editors
      // (Obsidian / VS Code rename). Skipped silently when the old
      // file is already gone (user deleted it externally, or first
      // write of the session).
      const oldMd = lastWrittenPath.get(slug)
      if (oldMd && oldMd !== mdPath) {
        const oldSidecar = oldMd.replace(/\.md$/, '.marks.json')
        const oldYdoc = oldMd.replace(/\.md$/, '.ydoc')
        if (await vaultFileExists(oldMd)) {
          await renameVaultFile(oldMd, mdPath)
        }
        if (await vaultFileExists(oldSidecar)) {
          await renameVaultFile(oldSidecar, sidecarPath)
        }
        if (await vaultFileExists(oldYdoc)) {
          await renameVaultFile(oldYdoc, ydocPath)
        }
      }
      await writeVaultFile(mdPath, result.md)
      await writeVaultFile(sidecarPath, JSON.stringify(result.sidecar, null, 2))
      if (ydocBinary) {
        await writeVaultBinary(ydocPath, ydocBinary)
      }
      lastWrittenPath.set(slug, mdPath)
      clearDirty(slug)
    } catch (err) {
      console.warn('[vault:flush] write failed for', slug, err)
      // Leave dirty so the next tick retries.
    }
  }
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

// ── One-shot IDB → vault backfill ────────────────────────────────
//
// Closes the gap left by Phase 4 landing on top of an existing IDB:
// docs that were created before this codebase existed (or before the
// user picked a vault) live in IDB but never reached disk, so they
// show in the sidebar yet are invisible to CLI / Finder / git.
//
// Strategy per slug:
//   1. Compute its vault path. Skip if the doc type has no on-disk
//      placement (e.g. 'writing') or if the .md already exists.
//   2. Open a SHORT-LIVED Y.Doc + IDB persistence with the same slug
//      key — IDB hydrates the body and marks Map exactly like the
//      live handle would.
//   3. Read the fragment + marks Map directly off that temp doc and
//      serialize via the shared editor schema + Milkdown serializer.
//   4. Atomic-write .md + .marks.json, then destroy the temp handle.
//
// Why a temp handle instead of going through ensureHandle:
//   ensureHandle registers the handle in docsStore and installs the
//   dirty observer permanently. We'd end up holding N ydocs in memory
//   for the rest of the session, defeating the lazy-with-cache design.
//   The temp Y.Doc lives only long enough to read + serialize.
//
// Why direct serialize instead of mounting the editor for each slug:
//   Cycling the EditorView through every closed doc would flash the UI
//   and cost a full Milkdown setup per page. We already have the schema
//   and serializer from the active editor — those are constants across
//   docs, so we can serialize any PM node built from any Y.Doc using
//   them.

/** Read the marks Y.Map directly from a (possibly inactive) Y.Doc and
 * convert valid entries to sidecar form. Mirrors the markStore.list +
 * buildSidecarMarks pipeline but bypasses the handle registry so it
 * works on the backfill's temp ydoc. */
function buildSidecarMarksFromYDoc(ydoc: Y.Doc, md: string): MarkSidecar[] {
  const marksMap = ydoc.getMap<Mark>('marks')
  const out: MarkSidecar[] = []
  marksMap.forEach((raw) => {
    if (!isValidMark(raw)) return
    const anchor = buildAnchorForMark(md, raw)
    if (!anchor) return
    out.push(markToSidecar(raw, anchor))
  })
  return out
}

/** Backfill a single slug. Returns true when a write happened. Silent
 * skips: doc type has no path, file already on disk, IDB empty, or
 * serializer not ready yet. The caller logs the aggregate result. */
async function backfillOneSlug(
  slug: string,
  schema: import('@milkdown/kit/prose/model').Schema,
  serializer: (doc: import('@milkdown/kit/prose/model').Node) => string,
): Promise<boolean> {
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) return false
  const getDoc = (s: string) => docs.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  const sidecarPath = sidecarPathForDoc(known, getDoc)
  if (!mdPath || !sidecarPath) return false
  if (await vaultFileExists(mdPath)) return false

  const ydoc = new Y.Doc()
  const idb = new IndexeddbPersistence(slug, ydoc)
  try {
    await idb.whenSynced
    const fragment = ydoc.getXmlFragment('prosemirror')
    // Effective-empty: IDB had nothing real for this slug. Common for
    // catalog entries that were created but never typed into (e.g.
    // week-ahead daily placeholders bootstrap seeds). Skip rather than
    // writing an empty .md that would pollute the vault.
    if (deriveLabel(fragment).length === 0) return false

    let md: string
    try {
      const pmNode = yXmlFragmentToProseMirrorRootNode(fragment, schema)
      md = serializer(pmNode)
    } catch (err) {
      console.warn('[backfill] serialize failed', slug, err)
      return false
    }

    const sidecar: MarksSidecarFile = {
      version: 1,
      slug,
      marks: buildSidecarMarksFromYDoc(ydoc, md),
    }

    try {
      await writeVaultFile(mdPath, md)
      await writeVaultFile(
        sidecarPath,
        `${JSON.stringify(sidecar, null, 2)}\n`,
      )
      // Seed the rename tracker so a later title change moves this
      // file rather than creating a duplicate. Without this, the
      // first flush after the user edits a backfilled doc would see
      // no oldPath and emit a fresh write.
      lastWrittenPath.set(slug, mdPath)
    } catch (err) {
      console.error('[backfill] write failed', slug, err)
      return false
    }
    return true
  } finally {
    idb.destroy()
    ydoc.destroy()
  }
}

/** One-shot pass: write every IDB-resident doc that doesn't yet exist
 * on disk. Idempotent — a re-run after the first finds existing files
 * and skips them, so callers can fire it on every boot.
 *
 * Returns a summary so the caller can log it. Failure of any single
 * slug is logged internally and counted; it doesn't abort the rest.
 *
 * Preconditions: vault selected + an editor view mounted (we need its
 * schema + serializer). Both are met right after BootGate flips, since
 * bootstrap eagerly opens today's daily. */
export async function backfillVaultFromIdb(): Promise<{
  total: number
  wrote: number
  skipped: number
  failed: number
}> {
  if (!getActiveVaultPath()) {
    return { total: 0, wrote: 0, skipped: 0, failed: 0 }
  }
  const { view, serializer } = useEditorViewStore.getState()
  if (!view || !serializer) {
    return { total: 0, wrote: 0, skipped: 0, failed: 0 }
  }
  const schema = view.state.schema

  const allKnown = useDocsStore.getState().knownDocs
  const getDoc = (s: string) => allKnown.find((d) => d.slug === s)
  const knownDocs = allKnown.filter(
    (d) => !d.archivedAt && pathForDoc(d, getDoc) !== null,
  )

  let wrote = 0
  let skipped = 0
  let failed = 0
  for (const doc of knownDocs) {
    try {
      const ok = await backfillOneSlug(doc.slug, schema, serializer)
      if (ok) wrote++
      else skipped++
    } catch (err) {
      console.error('[backfill] slug failed', doc.slug, err)
      failed++
    }
  }
  return { total: knownDocs.length, wrote, skipped, failed }
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
  const loadHandle = async (slug?: string): Promise<SerializedDocFiles | null> => {
    const target = slug ?? useDocsStore.getState().activeSlug
    if (!target) return null
    return loadDocFromFiles(target)
  }
  ;(window as unknown as { __loadDoc: typeof loadHandle }).__loadDoc = loadHandle
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
  ;(window as unknown as {
    __backfill: typeof backfillVaultFromIdb
  }).__backfill = backfillVaultFromIdb
}
