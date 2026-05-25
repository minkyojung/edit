/**
 * docsStore — handle lifecycle slice.
 *
 * Owns the runtime in-memory state for the doc handles:
 *   - `handles`  — slug → CollabHandle (the live Y.Doc and its
 *                  contentReady promise + slug back-pointer)
 *   - `status`   — slug → CollabStatus ('loading' | 'ready' | 'error')
 *
 * Promotes `ensureHandle` to a store action. Pre-Phase-6 it was a
 * free function that callers passed `set`/`get` into; that pattern
 * worked but read awkwardly because every call site had to forward
 * the store internals. Now every other slice just calls
 * `get().ensureHandle(slug)` — same lazy-cache idempotency, no
 * plumbing.
 *
 * The file-local helpers (`buildHandle`, `seedBodyFirstLine`,
 * `seedMetaFromCatalog`) stay close to `ensureHandle` since they
 * exist only to support it. `scrubDailyTitleArtifacts` is exported
 * because bootstrap + openDaily (in other slices) need to call it
 * post-hydrate.
 */

import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { useIngestStore } from '../ingestStore'
import { deriveLabel } from '@/lib/docLabel'
import { applyVaultBodyToYDoc, installDocSync } from '@/lib/docFileSync'
import { writeDocMeta } from '@/hooks/useDocMeta'
import { useEditorViewStore } from '@/state/editorViewStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
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
   * Y.Doc. Used by the vault watcher when an external edit lands on a
   * file the app already has loaded. No-op when the handle isn't
   * built yet (the next ensureHandle will hydrate from disk anyway).
   * Caller is responsible for the dirty / conflict gate — this just
   * does the read-and-apply. */
  reloadFromVault: (slug: string) => Promise<void>
  /** Append a freshly-discovered doc to `knownDocs` so the sidebar
   * picks it up immediately. No-op when a doc with the same slug is
   * already present — protects against the race where our own
   * create flow's `.md` write echoes back as a watch event. */
  addKnownDoc: (doc: KnownDoc) => void
  /** Drop a doc from the catalog after its file disappeared from
   * disk. If the doc is currently open as a tab, closes it first so
   * the ydoc tear-down + tab-strip invariants run through their
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
      seedBodyFirstLine(handle.ydoc, opts.seedFirstLine)
    }
    set((s) => ({ handles: { ...s.handles, [slug]: handle } }))
    seedMetaFromCatalog(handle, get().knownDocs.find((d) => d.slug === slug))
    // Path C Step 4: title-mirror removed (Obsidian model). Body and
    // filename are decoupled — typing in the body never changes the
    // doc's title. Title changes go through the explicit renameDoc
    // action; the rename-on-change machinery moves the file on disk.
  },

  reloadFromVault: async (slug) => {
    const handle = get().handles[slug]
    if (!handle?.ydoc) return
    const outcome = await applyVaultBodyToYDoc(handle.ydoc, slug, {
      reload: true,
    }).catch((err) => {
      console.warn('[vault:reload] failed for', slug, err)
      return 'no-vault' as const
    })
    if (outcome === 'applied') {
      // Phase 3 of the Yjs-removal migration: with `@milkdown/plugin-collab`
      // gone, an applyUpdate to the handle's Y.Doc no longer propagates
      // into the live ProseMirror EditorState. When the reloaded slug
      // matches the currently-mounted editor, push the freshly-hydrated
      // fragment into PM ourselves via a non-undoable replace. Inactive
      // slugs don't need this — their next mount reads the fragment the
      // same way (see MilkdownEditor.tsx's post-create hydrate).
      const activeSlug = getActiveSlugFromHash()
      if (activeSlug === slug) {
        const view = useEditorViewStore.getState().view
        if (view) {
          try {
            const fragment = handle.ydoc.getXmlFragment('prosemirror')
            const root = yXmlFragmentToProseMirrorRootNode(
              fragment,
              view.state.schema,
            )
            view.dispatch(
              view.state.tr
                .replaceWith(0, view.state.doc.content.size, root.content)
                .setMeta('addToHistory', false),
            )
          } catch (err) {
            console.warn(
              '[vault:reload] PM dispatch failed for',
              slug,
              err,
            )
          }
        }
      }
      console.log(`[vault:reload] ${slug} hydrated from external edit`)
    }
  },

  addKnownDoc: (doc) => {
    set((s) => {
      if (s.knownDocs.some((d) => d.slug === doc.slug)) return s
      return { knownDocs: [...s.knownDocs, doc] }
    })
  },

  removeKnownDoc: (slug) => {
    // If the doc has an open tab, close it first. closeDoc handles
    // ydoc.destroy, openSlugs / activeSlug shift, handles / status
    // cleanup, and the non-empty-tab-strip invariant — re-implementing
    // those here would duplicate the careful ordering closeDoc already
    // gets right. We just need to make sure closeDoc runs BEFORE we
    // drop the doc from knownDocs, since some of its sub-steps (e.g.
    // ensureHandle on a fallback tab) read the catalog.
    if (get().openSlugs.includes(slug)) {
      get().closeDoc(slug)
    }
    set((s) => ({
      knownDocs: s.knownDocs.filter((d) => d.slug !== slug),
      expandedDocSlugs: s.expandedDocSlugs.filter((s2) => s2 !== slug),
    }))
  },
})

// ── File-local helpers ──────────────────────────────────────────────

/** Synchronous local-only handle construction. The Y.Doc comes up
 * immediately so the editor can mount; content arrives async via the
 * vault load chained on contentReady. There is no IndexedDB layer in
 * Path C — the vault file is the only durable surface and the ydoc
 * lives only in memory for the session.
 *
 * Takes `get` so the ingest observer fired by `fragment.observeDeep`
 * can read the live catalog at fire-time. The observer captures `get`
 * (a stable function reference), not a snapshot of state. */
function buildHandle(
  slug: string,
  get: GetDocsState,
  onStatus: (status: CollabStatus) => void,
): CollabHandle {
  const ydoc = new Y.Doc()

  // contentReady: doc-hydration signal that consumers await before
  // touching content-dependent state (editor binding, mark store
  // reads, dirty observers, chat threads). Spans:
  //   1. Vault load        (.md + sidecar → Y.Doc)
  //   2. installDocSync    (start watching for dirty-mark observers)
  //   3. ingest observer   (mark this slug "edited" on any change)
  //
  // Folding (2) and (3) into the same chain means dirty tracking only
  // begins AFTER the initial hydrate, so the seed doesn't register
  // as a fresh edit.
  let vaultSyncDisposer: (() => void) | null = null
  const contentReady = (async () => {
    const fragment = ydoc.getXmlFragment('prosemirror')
    if (deriveLabel(fragment).length === 0) {
      const outcome = await applyVaultBodyToYDoc(ydoc, slug).catch((err) => {
        console.warn('[vault:load] failed for', slug, err)
        return 'no-vault' as const
      })
      if (outcome === 'applied') {
        console.log(`[vault:load] hydrated ${slug} body from vault`)
      }
    }
    vaultSyncDisposer = installDocSync(slug, ydoc)

    // Ingest dirty-bit observer. Installed AFTER hydrate so the
    // initial seed doesn't register as a fresh edit. Agent-managed
    // pages (system:* + wiki:*) are filtered out — those pages are
    // output, not input. No explicit unobserve: ydoc.destroy() in
    // closeDoc tears down all observers attached to its fragments.
    fragment.observeDeep(() => {
      const known = get().knownDocs.find((d) => d.slug === slug)
      if (!known || isWikiDoc(known)) return
      useIngestStore.getState().markEdited(slug)
    })
  })()
  const handle: CollabHandle = {
    ydoc,
    contentReady,
    slug,
  }
  // Expose disposer via the handle's destroy chain by piggy-backing
  // on ydoc.destroy. closeDoc already calls ydoc.destroy(); add the
  // disposer call before destroying so observer cleanup runs while
  // the doc is still mountable.
  const originalDestroy = ydoc.destroy.bind(ydoc)
  ydoc.destroy = () => {
    vaultSyncDisposer?.()
    vaultSyncDisposer = null
    originalDestroy()
  }
  // Status flips to 'ready' once the doc's body + marks are fully
  // hydrated into the ydoc. 'error' covers the rare hydrate failure
  // so the footer can surface "storage unavailable" instead of
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

/** Seed the first paragraph of a freshly-built body fragment. Two
 * use cases:
 *   - `text === ''` — pre-fill the schema's default empty paragraph
 *     so MilkdownEditor's mount-time schema-fill never competes with
 *     a Yjs sync.
 *   - `text !== ''` — wikilink palette / create-with-title path: the
 *     new doc's body opens with the supplied wikilink text.
 *
 * No-op when the fragment is already non-empty — defensive against
 * a caller passing this option on a reopen path. */
function seedBodyFirstLine(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment('prosemirror')
  if (fragment.length > 0) return
  ydoc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    if (text.length > 0) {
      paragraph.insert(0, [new Y.XmlText(text)])
    }
    fragment.insert(0, [paragraph])
  }, 'doc-init')
}

/** Mirror catalog-level type/date into the doc's Y.Map('meta') the
 * first time we open the handle, so meta becomes the single source
 * of truth that everything else (normalize, footer, hover popovers)
 * can read without racing the bootstrap.
 *
 * No-op when meta.type already exists. createdAt is deliberately
 * NOT seeded here — back-stamping a fresh timestamp on a doc
 * created last week would lie about its age. Create paths set
 * createdAt themselves at the real creation moment. */
function seedMetaFromCatalog(
  handle: CollabHandle,
  known: KnownDoc | undefined,
): void {
  if (!known) return
  const metaMap = handle.ydoc.getMap('meta')
  if (metaMap.get('type')) return
  writeDocMeta(handle.ydoc, {
    type: known.type,
    date: known.type === 'daily' ? known.date : undefined,
  })
}

/** Strip the legacy `title` Y.Text on a daily doc's ydoc. Pre-Path-C
 * daily docs sometimes carried a title field; daily titles are now
 * derived from `meta.date`, so any stale text confuses surfaces
 * that read both. bootstrap + openDaily call this immediately after
 * the handle is ready to scrub the artefact. */
export function scrubDailyTitleArtifacts(ydoc: Y.Doc): void {
  const ytext = ydoc.getText('title')
  if (ytext.length === 0) return
  // 'doc-init' origin — system cleanup of legacy artefacts; not a
  // user action and not undo-able by design.
  ydoc.transact(() => {
    ytext.delete(0, ytext.length)
  }, 'doc-init')
}
