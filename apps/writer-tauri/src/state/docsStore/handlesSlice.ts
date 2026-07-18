/**
 * docsStore — handle lifecycle slice.
 *
 * Owns the runtime in-memory state for the doc handles:
 *   - `handles`  — slug → CollabHandle (the markdown body cache +
 *                  contentReady promise + per-handle destroy())
 *   - `status`   — slug → CollabStatus ('loading' | 'ready' | 'error')
 *
 * Phase 5c of the Yjs-removal migration retired the per-handle
 * `Y.Doc`. The handle now carries the body as a plain
 * `bodyMarkdown` cache; live edits flow through PM directly and the
 * flush loop serialises the active view to `.md` on the next tick.
 */

import { useIngestStore } from '../ingestStore'
import { installDocSync, markSlugDirty } from '@/lib/docFileSync'
import { updateDocBody, setBodyMirror } from './docBody'
import { useExternalConflictStore } from '@/state/externalConflictStore'
import { pathForDoc, usesFrontmatter } from '@/lib/docPaths'
import { splitFrontmatter } from '@/lib/frontmatter'
import { readVaultFile, vaultFileExists } from '@/lib/vault'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { isWikiDoc } from './helpers'
import type { GetDocsState, KnownDoc, SetDocsState } from './types'

export interface HandlesSlice {
  /** Map of slug → live CollabHandle for every open doc. */
  handles: Record<string, CollabHandle>
  /** Per-slug hydrate status — drives the editor footer's
   * "Saving / Saved / Storage unavailable" label. */
  status: Record<string, CollabStatus>
  /** Lazy-create the in-memory handle for `slug` if it doesn't already
   * exist. Idempotent — a second call for the same slug returns
   * immediately. See {@link DocsState.ensureHandle} for the full
   * contract. */
  ensureHandle: (
    slug: string,
    opts?: { seedFirstLine?: string },
  ) => Promise<void>
  /** Re-read this doc's body from the vault and apply it to the open
   * PM editor (when this slug is the active view). No-op when the
   * handle isn't built yet (the next ensureHandle will hydrate from
   * disk anyway). Caller is responsible for the dirty / conflict
   * gate — this just does the read-and-apply. */
  reloadFromVault: (slug: string) => Promise<void>
  /** Append a freshly-discovered doc to `knownDocs` so the sidebar
   * picks it up immediately. No-op when a doc with the same slug is
   * already present — protects against the race where our own
   * create flow's `.md` write echoes back as a watch event. */
  addKnownDoc: (doc: KnownDoc) => void
  /** Swap a doc's `relPath` (and, for a renamed file, its `title`) in
   * place — keeps slug/tab/handle — used when an external move/rename
   * reappears the same note at a new path. `title` is left untouched when
   * omitted. */
  updateKnownDocPath: (slug: string, relPath: string, title?: string) => void
  /** Drop a doc from the catalog after its file disappeared from
   * disk. If the doc is currently open as a tab, closes it first so
   * the handle tear-down + tab-strip invariants run through their
   * existing path (closeDoc) rather than a parallel implementation
   * here. Also scrubs `expandedDocSlugs` so the sidebar tree doesn't
   * keep referencing a slug that no longer exists. */
  removeKnownDoc: (slug: string) => void
}

export const createHandlesSlice = (
  set: SetDocsState,
  get: GetDocsState,
): HandlesSlice => ({
  handles: {},
  status: {},

  ensureHandle: async (slug, opts) => {
    if (get().handles[slug]) return
    const handle = buildHandle(
      slug,
      get,
      (status) => {
        set((s) => ({ status: { ...s.status, [slug]: status } }))
      },
    )
    if (opts?.seedFirstLine !== undefined) {
      seedBodyFirstLine(handle, opts.seedFirstLine)
    }
    set((s) => ({ handles: { ...s.handles, [slug]: handle } }))
    // Path C Step 4: title-mirror removed (Obsidian model). Body and
    // filename are decoupled — typing in the body never changes the
    // doc's title. Title changes go through the explicit renameDoc
    // action; the rename-on-change machinery moves the file on disk.
  },

  reloadFromVault: async (slug) => {
    const handle = get().handles[slug]
    if (!handle) return
    // Robust file-watcher pattern: read first, then decide. A read
    // that fails (transient disk error) or finds the file missing
    // (atomic-rename window mid-flight) is NOT the same as "the
    // user emptied the file" — collapsing the three into a single
    // empty-string outcome (the previous shape) would push an empty
    // PM through dispatch, and the next flushDirty tick would write
    // that empty back to disk, making the transient state permanent.
    // Same principle every robust file-based editor (VS Code,
    // Obsidian, iA Writer, …) follows: failures are skipped, the
    // next watcher event re-tries.
    const result = await loadBodyMarkdown(slug, get)
    if (result.kind === 'error') {
      console.warn(
        '[vault:reload] read error, keeping current PM',
        slug,
        result.error,
      )
      return
    }
    if (result.kind === 'missing') {
      console.warn(
        '[vault:reload] file missing on reload, keeping current PM',
        slug,
      )
      return
    }
    const refreshedMarkdown = result.markdown
    // Disk wins. Route through the body funnel so this external reload
    // serializes against any in-flight local write on the same slug, becomes
    // the single mirror write, pushes into the live editor (no-op when this
    // slug isn't mounted), and clears the dirty flag. `resolvesConflict`
    // bypasses the funnel's conflict gate — the user already chose to reopen,
    // so this write IS the resolution.
    await updateDocBody(slug, () => refreshedMarkdown, {
      source: 'external',
      resolvesConflict: true,
    })
    console.log(`[vault:reload] ${slug} hydrated from external edit`)
  },

  addKnownDoc: (doc) => {
    set((s) => {
      if (s.knownDocs.some((d) => d.slug === doc.slug)) return s
      return { knownDocs: [...s.knownDocs, doc] }
    })
  },

  updateKnownDocPath: (slug, relPath, title) => {
    // In-place swap for an externally-moved/renamed note — keeps the
    // slug, open tab, and handle intact (unlike remove+add, which tears
    // them down). Touches `relPath` (placement) and, when the filename
    // changed, `title` (the sidebar label for a generic note). `title`
    // is only overwritten when supplied, so a pure folder move that omits
    // it leaves the label alone.
    set((s) => ({
      knownDocs: s.knownDocs.map((d) =>
        d.slug === slug
          ? { ...d, relPath, ...(title !== undefined ? { title } : {}) }
          : d,
      ),
    }))
  },

  removeKnownDoc: (slug) => {
    // If the doc has an open tab, close it first. closeDoc handles
    // handle.destroy(), openSlugs / activeSlug shift, handles / status
    // cleanup, and the non-empty-tab-strip invariant — re-implementing
    // those here would duplicate the careful ordering closeDoc already
    // gets right. We just need to make sure closeDoc runs BEFORE we
    // drop the doc from knownDocs, since some of its sub-steps (e.g.
    // ensureHandle on a fallback tab) read the catalog.
    if (get().openSlugs.includes(slug)) {
      get().closeDoc(slug)
    }
    // Drop any external-edit conflict for the removed doc. closeDoc already
    // clears it for the open case; this covers a background handle (dirty but
    // no open tab) that was conflicted and is now being removed, so no stale
    // entry lingers in the conflict set. resolveConflict is idempotent.
    useExternalConflictStore.getState().resolveConflict(slug)
    set((s) => ({
      knownDocs: s.knownDocs.filter((d) => d.slug !== slug),
      expandedDocSlugs: s.expandedDocSlugs.filter((s2) => s2 !== slug),
    }))
  },
})

// ── File-local helpers ──────────────────────────────────────────────

/** Synchronous local-only handle construction. The handle comes up
 * immediately so the editor can mount; content arrives async via the
 * vault load chained on contentReady. There is no IndexedDB layer in
 * Path C — the vault `.md` file is the only durable surface and the
 * `bodyMarkdown` cache lives only in memory for the session.
 *
 * Takes `get` so the ingest observer that fires on PM edits (via the
 * dirty tracker plugin) can read the live catalog at fire-time. */
function buildHandle(
  slug: string,
  get: GetDocsState,
  onStatus: (status: CollabStatus) => void,
): CollabHandle {
  // contentReady: doc-hydration signal that consumers await before
  // touching content-dependent state (editor binding, dirty observers,
  // chat threads). Spans:
  //   1. Vault load        (.md → handle.bodyMarkdown)
  //   2. installDocSync    (start the per-slug dirty bookkeeping)
  //
  // Phase 5c retired the Y.Doc observer for ingest "edited" marking;
  // that signal moves with the PM-side dirty tracker (created on
  // mount in MilkdownEditor.tsx). For now we still flag the slug as
  // edited at hydrate time when it's a user-owned doc, so an LLM
  // ingest pass triggered immediately after open sees the freshest
  // body in its scan rather than a stale cache.
  let vaultSyncDisposer: (() => void) | null = installDocSync(slug)
  const handle: CollabHandle = {
    slug,
    bodyMarkdown: '',
    contentReady: Promise.resolve(), // assigned below after we build
                                     // the real promise. Placeholder
                                     // so the handle object can be
                                     // captured by the IIFE.
    destroy: () => {
      vaultSyncDisposer?.()
      vaultSyncDisposer = null
    },
  }
  handle.contentReady = (async () => {
    // Phase 5a of the Yjs-removal migration: snapshot the live
    // PM-equivalent markdown from disk. The discriminated
    // `LoadBodyResult` separates a real empty file from a transient
    // read failure (atomic-rename window, permission glitch). For
    // the initial hydrate we collapse both failure modes to an
    // empty cache — the editor's schema-fill gives the user a
    // usable blank doc and the next flush rewrites the file. The
    // "do not touch" semantics matter on the reload path, not here.
    const initialLoad = await loadBodyMarkdown(slug, get)
    // Construction: seed the mirror with the disk snapshot BEFORE contentReady
    // resolves. This isn't a transform (there's no prior body to read and no
    // editor mounted yet), so it writes the mirror directly via the sanctioned
    // setter rather than through updateDocBody (which would await the very
    // contentReady we're resolving).
    setBodyMirror(handle, initialLoad.kind === 'loaded' ? initialLoad.markdown : '')

    // Ingest dirty-bit signal. Installed AFTER hydrate so the
    // initial seed doesn't register as a fresh edit. Agent-managed
    // pages (system:* + wiki:*) are filtered out — those pages are
    // output, not input. Hooked off the PM dirty-tracker plugin
    // via markSlugDirty: when the user edits a doc, that path
    // already fires, so piggy-backing on it keeps the ingest
    // pipeline informed without re-wiring observers.
    const known = get().knownDocs.find((d) => d.slug === slug)
    if (known && !isWikiDoc(known)) {
      useIngestStore.getState().markEdited(slug)
    }
  })()
  // Status flips to 'ready' once the body is fully loaded into the
  // bodyMarkdown cache. 'error' covers the rare hydrate failure so
  // the footer can surface "storage unavailable" instead of
  // leaving the user silently writing into a session that won't
  // persist.
  onStatus('loading')
  handle.contentReady.then(
    () => onStatus('ready'),
    (err) => {
      console.error('[collab] content hydrate failed', err)
      onStatus('error')
    },
  )
  return handle
}

/** Seed the first line of a freshly-built handle's body cache. Used
 * by the wikilink palette / create-with-title path so the new doc
 * opens with the supplied wikilink text. No-op when the cache is
 * already non-empty — defensive against a caller passing this
 * option on a reopen path.
 *
 * The seed lands in `bodyMarkdown`; the mount-time hydrate paints it
 * into PM. Marking the slug dirty kicks the flush loop so the seed
 * reaches disk on the next 2s tick even if the user never types. */
function seedBodyFirstLine(handle: CollabHandle, text: string): void {
  if (handle.bodyMarkdown.trim().length > 0) return
  // Runs during ensureHandle, before contentReady — construction, not a
  // transform, so it writes the mirror directly via the sanctioned setter.
  setBodyMirror(handle, text)
  markSlugDirty(handle.slug)
}

/** Three distinct outcomes of a body-markdown read. Conflating them
 * (the prior `Promise<string>` shape) is the data-loss footgun the
 * standard file-watcher pattern explicitly prohibits: a transient
 * absence during an atomic-rename window would otherwise resolve to
 * `''`, the caller would interpret that as "the doc is now empty",
 * push that into PM, and the next flushDirty tick would write the
 * empty PM back to disk — making the transient state permanent.
 *
 * - `loaded`: read succeeded. `markdown` may be empty (the user
 *   genuinely cleared the file) and the caller honours that.
 * - `missing`: the file is not on disk right now. Two roots — a
 *   brand-new doc that's never been flushed, or an atomic-rename
 *   mid-flight. Callers that re-hydrate live state should treat
 *   this as "do nothing"; callers that initialise (buildHandle) can
 *   collapse it to an empty default.
 * - `error`: the read threw (permission, disk hiccup, etc.). Same
 *   "do nothing on hydrate" rule applies; the next watcher event
 *   re-triggers the read. */
export type LoadBodyResult =
  | { kind: 'loaded'; markdown: string }
  | { kind: 'missing' }
  | { kind: 'error'; error: unknown }

/** Read the doc's vault `.md` file. Returns a discriminated result
 * so callers can distinguish "no content" from "couldn't read" —
 * see {@link LoadBodyResult}. */
async function loadBodyMarkdown(
  slug: string,
  get: GetDocsState,
): Promise<LoadBodyResult> {
  const state = get()
  const known = state.knownDocs.find((d) => d.slug === slug)
  if (!known) return { kind: 'missing' }
  const getDoc = (s: string) =>
    state.knownDocs.find((d) => d.slug === s)
  const mdPath = pathForDoc(known, getDoc)
  if (!mdPath) return { kind: 'missing' }
  try {
    if (!(await vaultFileExists(mdPath))) return { kind: 'missing' }
    const raw = await readVaultFile(mdPath)
    // Frontmatter-native docs carry a `---` metadata block the editor must
    // never see (it would render as raw YAML and the user could clobber
    // identity fields). Strip it here so `bodyMarkdown` is body-only; the
    // flush re-attaches it on save (see usesFrontmatter in docFileSync).
    const markdown = usesFrontmatter(known)
      ? splitFrontmatter(raw).body
      : raw
    return { kind: 'loaded', markdown }
  } catch (error) {
    console.warn('[vault:load] bodyMarkdown read failed for', slug, error)
    return { kind: 'error', error }
  }
}
