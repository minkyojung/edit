/**
 * Vault folder watcher — keeps the in-memory catalog in sync with the
 * disk when files change from OUTSIDE the app (the Claude agent's
 * `mv` / writes, Finder, git pull, another editor).
 *
 * Listens to the OS file-system event stream for the active vault
 * folder, filters it, and routes each change to a catalog mutation:
 *   - create → `addKnownDoc` (a new note appears in the sidebar).
 *   - remove → `removeKnownDoc` (drops it from the catalog; debounced
 *     so a rename's remove leg can coalesce with its add leg).
 *   - rename / move → `updateKnownDocPath` in place (keeps the slug,
 *     open tab, and handle; refreshes the sidebar label on a rename).
 *   - modify (content) → `reloadFromVault` re-reads the body into the
 *     open editor. When the local copy has unsaved edits, this is a
 *     CONFLICT: instead of clobbering either side, it marks the slug
 *     and surfaces a toast with a "Reload" action.
 *
 * Own writes are dropped via `isDiskContentKnown()` from `vault.ts`: it holds
 * one belief per path about what that file contains, updated on every write, so
 * an event whose on-disk content already matches has nothing to report. Without
 * it every flush tick would ping-pong back as a phantom "external change". External wiki changes
 * also invalidate the Tier 1 index, and create/remove bursts refresh
 * the folder inventory (debounced).
 *
 * Lifecycle:
 *   - `startVaultWatcher()` — called at app boot, gated on
 *     `getActiveVaultPath()`. Returns the dispose function so the
 *     caller (App.tsx) can clean up on teardown.
 *   - Returns no-op when no vault is selected (vault picker hasn't run
 *     yet). App.tsx re-invokes it when the active vault changes.
 */

import { watchImmediate } from '@tauri-apps/plugin-fs'
import { normalize } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useDocsStore } from '@/state/docsStore'
import { findSlugByVaultPath } from '@/state/docsStore/helpers'
import { pathForDoc } from '@/lib/docPaths'
import { invalidateWikiIndex } from '@/state/wikiIndex'
import { invalidateVaultTimeline } from '@/state/vaultTimeline'
import {
  hashContent,
  isDiskContentKnown,
  listVaultTreeRecursive,
  readVaultFile,
  vaultFileExists,
} from './vault'
import { splitFrontmatter } from './frontmatter'
import { isDirty } from './docFileSync'
import { buildKnownDocForExternalPath } from './scanVault'
import { useExternalConflictStore } from '@/state/externalConflictStore'
import { bumpArtifactRevision } from '@/state/artifactRevisionStore'
import { useGitStore } from '@/state/gitStore'
import { notify } from './notify'

/** Vault subpaths whose changes count as user-visible activity. Mirrors
 * the same prefixes gitStore uses to decide which commits to surface
 * in the Review panel. Any external edit (sidecar built-in Edit tool,
 * Obsidian, Claude Code CLI, manual fs.write) that lands under one of
 * these dirs gets routed through `noteActivity` so chat-turn or boot-
 * safety commits can pick it up. */
const ACTIVITY_PREFIXES = ['daily/', 'wiki/', 'writing/'] as const

function isActivityPath(rel: string): boolean {
  return ACTIVITY_PREFIXES.some((p) => rel.startsWith(p))
}

let activeUnwatch: (() => void) | null = null

/** Folder create/rename/delete AND non-markdown file add/remove (incl.
 * external Finder changes) never surface as watchable `.md` files, so the
 * file router below ignores them — leaving the sidebar's folder inventory
 * (`knownFolders`) and attachment inventory (`knownFiles`) stale. Re-read
 * both on any create/remove burst, debounced so a batch op (or our own
 * write) collapses to one cheap walk. */
let folderRefreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleFolderRefresh(): void {
  if (folderRefreshTimer) clearTimeout(folderRefreshTimer)
  folderRefreshTimer = setTimeout(() => {
    folderRefreshTimer = null
    void listVaultTreeRecursive()
      .then(({ dirs, files }) =>
        useDocsStore.setState({ knownFolders: dirs, knownFiles: files }),
      )
      .catch((err) => console.warn('[watch] tree refresh failed', err))
  }, 400)
}

/** How long to wait for an artifact's writer to finish before telling the view
 * to re-render. A `Write` is truncate-then-write, not an atomic rename, and
 * macOS emits several data events across one of them — bumping on the first
 * would render a half-written file. Trailing, per path, so a burst collapses to
 * one bump. Same 400ms as the folder refresh above; both are "wait for the
 * filesystem to settle", not a latency budget. */
const ARTIFACT_SETTLE_MS = 400
const artifactBumpTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tell the artifact view that this file changed, once the writes stop.
 *
 * `noteActivity` fires with the bump rather than separately because artifacts
 * have no review card — git is the only way back from one the user doesn't want,
 * and a commit only happens if something marked the path dirty. `git_commit`
 * already does `git add -A`, so nothing else is needed to get the file INTO the
 * commit; this is only what makes a commit happen at all.
 *
 * No echo suppression here, unlike the `.md` path: nothing in the app writes
 * artifacts through the vault helpers, so there is no belief to compare against,
 * and `isDiskContentKnown` would read the whole file — the one thing the asset
 * protocol lets us avoid. A spurious bump would only remount, which is harmless;
 * revisit if the host ever starts writing artifacts itself. */
function scheduleArtifactBump(rel: string): void {
  const pending = artifactBumpTimers.get(rel)
  if (pending) clearTimeout(pending)
  artifactBumpTimers.set(
    rel,
    setTimeout(() => {
      artifactBumpTimers.delete(rel)
      bumpArtifactRevision(rel)
      useGitStore.getState().noteActivity(rel)
    }, ARTIFACT_SETTLE_MS),
  )
}

/** An artifact that just went away must NOT be re-rendered: the frame would
 * reload a missing file, and an `<iframe>` reports nothing for a 404, so the
 * user would get a blank pane instead of the last good render or a fallback.
 * Cancelling a pending bump matters too — a modify followed by a delete would
 * otherwise still fire it. The deletion is recorded for git either way. */
function handleArtifactRemoved(rel: string): void {
  const pending = artifactBumpTimers.get(rel)
  if (pending) {
    clearTimeout(pending)
    artifactBumpTimers.delete(rel)
  }
  useGitStore.getState().noteActivity(rel)
}

/** Start watching the active vault. Returns a disposer; calling it
 * (or `stopVaultWatcher`) tears the watcher down. Safe to call
 * repeatedly — re-invocation replaces the existing watcher. */
export async function startVaultWatcher(): Promise<() => void> {
  // Tear down any previous watcher so a vault-path change (future
  // settings-panel feature) doesn't leave stale watchers running.
  stopVaultWatcher()

  const rawVaultPath = getActiveVaultPath()
  if (!rawVaultPath) {
    console.log('[watch] no vault selected; watcher inert')
    return () => {}
  }
  // Normalise once at startup so the prefix-strip in `toVaultRelative`
  // compares against the same canonical shape Tauri's watch produces
  // for incoming event paths. Without this a vault picked as
  // `~/Documents/Writer/` (trailing slash) or with extra `./` segments
  // can silently fail to match incoming `/Users/.../Writer/...`
  // events, leaking watcher events through as "external" even when
  // they're our own writes.
  const vaultPath = await normalize(rawVaultPath)

  console.log('[watch] starting on', vaultPath)
  const unwatch = await watchImmediate(
    vaultPath,
    (event) => {
      // Tauri's watch callback fires for every fsevent. On macOS
      // the event shape is `{ type: { create: {...} | modify: {...} | remove: {...} }, paths: [...] }`.
      // Paths can be either vault-relative (most events) or absolute
      // (whole-dir metadata pings) — `toVaultRelative` normalises.
      if (!isActionableEvent(event)) return

      // A create/remove burst may be a folder add / rename / delete (or
      // a file add/remove that creates/empties a folder) — refresh the
      // folder inventory so empty + renamed folders stay in sync.
      if (isCreateOrRemoveEvent(event)) scheduleFolderRefresh()

      const rawPaths = Array.isArray(event.paths) ? event.paths : []
      const relPaths = rawPaths.map((p) => toVaultRelative(p, vaultPath))

      // Rendered HTML artifacts, handled entirely beside the `.md` router below
      // and never through it: everything downstream of `isWatchableBodyFile`
      // assumes a slug-bearing note (reload, rename correlation, conflict
      // marking), and an artifact has no slug, no catalog entry and no editor
      // buffer. Widening that predicate instead of branching here is the way to
      // break the note path.
      const artifacts = relPaths.filter(isWatchableArtifactFile)
      if (artifacts.length > 0) {
        const removed = isRemoveEvent(event)
        for (const rel of artifacts) {
          if (removed) handleArtifactRemoved(rel)
          else scheduleArtifactBump(rel)
        }
      }

      // Keep only paths that are interesting body files (`.md` inside
      // `wiki/`, `daily/`, or `_system/`). Everything else is either:
      //   - an app-internal sidecar (`.meta.json`, `.ydoc`) that the
      //     user shouldn't be editing directly
      //   - a tmp companion of the atomic write (`.md.tmp`, etc.)
      //   - a directory entry (no concrete file to load)
      const candidates = relPaths.filter(isWatchableBodyFile)
      if (candidates.length === 0) return

      // Echo suppression is async (reads the file and hashes the
      // bytes) so we hand off to a separate async flow rather than
      // making the watch callback itself async — the Tauri plugin's
      // listener signature is sync.
      void resolveAndDispatch(event, candidates, rawPaths)
    },
    // watchImmediate (no debounce) — external edits reflect right away;
    // the default debounced `watch` was adding latency / missing events.
    { recursive: true },
  )
  activeUnwatch = unwatch
  return unwatch
}

/** Filter the candidate paths by reading each from disk and comparing against
 * what we believe that file holds. Anything already matching our belief has
 * nothing to tell us and is dropped; the rest is a real external change and is
 * dispatched.
 *
 * The question is "is this what I already know?", NOT "did I write this
 * content at some point recently" — see `knownDiskHashes` for why the second
 * one silently swallowed `git revert`. */
async function resolveAndDispatch(
  event: { type: unknown },
  candidates: string[],
  rawPaths: string[],
): Promise<void> {
  const checks = await Promise.all(
    candidates.map(async (rel) => ({ rel, ours: await isDiskContentKnown(rel) })),
  )
  const external = checks.filter((c) => !c.ours).map((c) => c.rel)
  if (external.length === 0) {
    console.log('[watch] already known', candidates)
    return
  }
  // Not a name for a failure: these are paths whose content differs from what
  // we knew, which is exactly what the watcher exists to catch. Logged because
  // an unexpected one still points at a write that skipped the vault helpers.
  console.log('[watch] external change', { external, rawPaths })
  dispatchEvent(event, external)
}

/** Stop the active vault watcher if any. Idempotent. */
export function stopVaultWatcher(): void {
  if (activeUnwatch) {
    activeUnwatch()
    activeUnwatch = null
  }
  // Pending artifact bumps are keyed by vault-RELATIVE path, so one left
  // in flight across a vault switch would fire against the new vault and
  // remount whatever happens to sit at the same relative path.
  for (const timer of artifactBumpTimers.values()) clearTimeout(timer)
  artifactBumpTimers.clear()
}

/** Convert an absolute path emitted by the watcher into a vault-
 * relative path (the same form `markOurRecentWrite` records).
 * Returns the path unchanged when it's already relative or falls
 * outside the vault — Tauri's watch emits a mix of absolute and
 * relative paths on macOS depending on the event kind. */
function toVaultRelative(rawPath: string, vaultRoot: string): string {
  const normalizedRoot = vaultRoot.endsWith('/') ? vaultRoot : `${vaultRoot}/`
  if (rawPath.startsWith(normalizedRoot)) {
    return rawPath.slice(normalizedRoot.length)
  }
  return rawPath
}

/** True for fsevents that represent content changes we care about.
 * Filters out:
 *   - `modify.kind === 'metadata'` — mtime / xattr pings that fire
 *     after every write on macOS; not actionable.
 *   - Any other event we don't have a handler for yet (the router
 *     in Phase 4.E.2 will replace this with finer matching).
 *
 * Today we keep create / remove / modify.data / modify.rename, which
 * cover "new file", "deleted file", "saved-over file", and "atomic-
 * write rename" respectively. */
function isActionableEvent(event: { type: unknown }): boolean {
  const type = event.type as
    | { create?: unknown }
    | { remove?: unknown }
    | { modify?: { kind?: string } }
    | { access?: unknown }
    | undefined
  if (!type) return false
  if ('create' in type && type.create) return true
  if ('remove' in type && type.remove) return true
  if ('modify' in type && type.modify) {
    // Metadata-only changes (mtime, xattr) are not actionable —
    // every write produces them as a tail. Rename + data changes
    // are.
    const kind = type.modify.kind
    return kind !== 'metadata'
  }
  return false
}

/** True for create or remove fsevents (folder churn shows up as these,
 * never as `modify`). Used to gate the folder-inventory refresh so plain
 * file edits don't trigger a dir walk. */
function isCreateOrRemoveEvent(event: { type: unknown }): boolean {
  const type = event.type as
    | { create?: unknown; remove?: unknown }
    | undefined
  if (!type) return false
  return ('create' in type && !!type.create) || ('remove' in type && !!type.remove)
}

/** True for remove fsevents only. `isCreateOrRemoveEvent` above deliberately
 * lumps the two together for the folder refresh, which wants both; the artifact
 * branch has to tell them apart because a removal must not trigger a re-render.
 */
function isRemoveEvent(event: { type: unknown }): boolean {
  const type = event.type as { remove?: unknown } | undefined
  return !!type && 'remove' in type && !!type.remove
}

/** Pure routing decisions extracted from the watcher handlers so they
 * can be regression-tested without spinning up the fs event stream, a
 * vault on disk, or the store. The handlers below call these; the live
 * verification covers the I/O wiring around them. Three decisions, each
 * a spot we actually shipped a bug at:
 *
 *   A. {@link classifyModify} — a `modify` event is a move/rename
 *      (`kind:'rename'`) vs a plain content save (everything else →
 *      reload). Getting this wrong routed external moves through reload,
 *      so the open tab closed and reopened instead of following the file.
 *   B. {@link renameLeg} — a single rename event names one path with no
 *      direction, so disk presence decides whether it's the move's
 *      destination (add) or its source (remove).
 *   C. {@link planReappear} — when a rebuilt doc shares a slug with a
 *      known one, decide whether to add (new), update placement+label
 *      (move/rename), or no-op (echo). Skipping the title refresh left
 *      the sidebar row showing the pre-rename name.
 */
export type ModifyRoute = 'rename' | 'reload'
export function classifyModify(kind: string | undefined): ModifyRoute {
  return kind === 'rename' ? 'rename' : 'reload'
}

export type RenameLeg = 'add' | 'remove'
export function renameLeg(existsOnDisk: boolean): RenameLeg {
  return existsOnDisk ? 'add' : 'remove'
}

export type ReappearPlan =
  | { kind: 'add' }
  | { kind: 'update'; relPath: string; title: string | undefined }
  | { kind: 'noop' }

/** Decide what to do when a freshly built KnownDoc lands. `existing` is
 * the catalog entry sharing its slug (undefined when none). A blank
 * `rebuilt.relPath` can't reposition anything, so it degrades to no-op
 * rather than writing an empty placement. */
export function planReappear(
  existing: { relPath?: string; title?: string } | undefined,
  rebuilt: { relPath?: string; title?: string },
): ReappearPlan {
  if (!existing) return { kind: 'add' }
  if (
    rebuilt.relPath &&
    (existing.relPath !== rebuilt.relPath || existing.title !== rebuilt.title)
  ) {
    return { kind: 'update', relPath: rebuilt.relPath, title: rebuilt.title }
  }
  return { kind: 'noop' }
}

/** Classify a single external fsevent and dispatch each path to the
 * matching handler stub. Phase 4.E.2 — no mutations yet; handlers
 * log a classification line so we can verify the router's decisions
 * against the live event stream before wiring real reload / add /
 * remove logic in Phase 4.E.3.
 *
 * macOS occasionally emits `rename` as a `create + remove` pair
 * within a single burst; we treat each leg independently here and
 * leave coalescing to the next phase. */
function dispatchEvent(event: { type: unknown }, paths: string[]): void {
  const type = event.type as
    | { create?: unknown }
    | { remove?: unknown }
    | { modify?: { kind?: string } }
    | undefined
  if (!type) return

  // The vault index maps the WHOLE vault, so any external `.md` change —
  // in any folder, not just `wiki/` — shifts it: body edits change a
  // row's summary + backlink counts, create/remove change the catalog
  // itself. Invalidate once per burst rather than per handler call so
  // concurrent renames don't thrash the cache. Excluded: `_system/` (the
  // index writes there itself — rebuilding on our own write would loop;
  // our writes are already echo-filtered, this is belt-and-braces). Chat
  // storage under `.octave/` never reaches here — it holds no `.md` and the
  // watcher's dot-segment filter drops it anyway. Non-`.md` attachments
  // don't carry summaries or backlinks, so they don't move the index.
  if (paths.some((p) => p.endsWith('.md') && !p.startsWith('_system/'))) {
    invalidateWikiIndex()
    invalidateVaultTimeline()
  }

  if ('create' in type && type.create) {
    for (const rel of paths) handleExternalAdd(rel)
    return
  }
  if ('remove' in type && type.remove) {
    for (const rel of paths) handleExternalRemove(rel)
    return
  }
  if ('modify' in type && type.modify) {
    // macOS notify delivers an external move/rename as a pair of
    // `modify`/`rename`/`mode:'any'` events — one naming the old path,
    // one the new — NOT as create+remove. Route those to the rename
    // handler (which splits them into the add / remove legs A2's
    // move-coalescing already understands). Plain content saves arrive
    // as `kind: 'data'` and still reload in place.
    const kind = (type.modify as { kind?: string }).kind
    if (classifyModify(kind) === 'rename') {
      for (const rel of paths) void handleExternalRename(rel)
      return
    }
    for (const rel of paths) handleExternalReload(rel)
    return
  }
}

/** External write landed on a known `.md`. Decision tree:
 *
 *   1. Path doesn't match any known slug → ignore. Either an orphan
 *      file the user dropped in without a matching catalog entry, or
 *      an in-flight rename whose `add` side will reach us as a
 *      separate event.
 *   2. Handle not yet built → no-op. The next `ensureHandle` call
 *      will hydrate from the (now-updated) disk file naturally; no
 *      reason to materialise a handle just to refresh it.
 *   3. Local copy dirty → skip with a console warning. The user has
 *      unsaved edits queued; silently overwriting them with the
 *      external version would lose work. Phase 4.E.4 surfaces this
 *      as a banner with a "Reload" action; for now the user
 *      can manually close-and-reopen the tab to force a reload.
 *   4. Clean + open → call the store's reloadFromVault action, which
 *      re-reads the body and applies it to the live Y.Doc.
 */
function handleExternalReload(rel: string): void {
  // Tell gitStore an external write happened so the next chat-turn
  // commit (or the boot safety net) picks it up. We run this *before*
  // the slug / handle gates so even a write to a doc that isn't
  // currently open still flows into git. `noteActivity` is idempotent
  // (Set.add), so duplicate calls from our own write path don't hurt.
  if (isActivityPath(rel)) {
    useGitStore.getState().noteActivity(rel)
  }
  const state = useDocsStore.getState()
  const slug = findSlugByVaultPath(state.knownDocs, rel)
  if (!slug) return
  if (!state.handles[slug]) return
  if (isDirty(slug)) {
    // Conflict: external version diverges from the live Y.Doc and
    // the local has unsaved edits. Auto-reloading would clobber the
    // local; auto-flushing would clobber the external. Mark and
    // surface a toast so the user picks. flushDirty respects the
    // conflict set and skips this slug until resolved.
    const conflict = useExternalConflictStore.getState()
    // markConflict is idempotent — already-marked slugs short-circuit
    // and we skip the toast too. Otherwise a second fsevent in a
    // burst (macOS sometimes coalesces rename + modify) would stack
    // duplicate toasts on the same conflict.
    if (conflict.hasConflict(slug)) return
    conflict.markConflict(slug)
    const known = state.knownDocs.find((d) => d.slug === slug)
    const fileName = known?.title?.trim() || rel
    notify.externalEditConflict({
      fileName,
      onReopen: () => {
        // Reload first, then clear — auto-flush is still gated on
        // the conflict set, so a tick can't race in between.
        void state.reloadFromVault(slug).then(() => {
          useExternalConflictStore.getState().resolveConflict(slug)
        })
      },
      onDismiss: () => {
        useExternalConflictStore.getState().resolveConflict(slug)
      },
    })
    return
  }
  void state.reloadFromVault(slug)
}

/** New `.md` appeared under a watched subtree. Decision tree:
 *
 *   1. Path already maps to a known slug → no-op. Same shape as the
 *      reload echo race: our own create flow writes the file, the
 *      watcher fires `create`, and the echo filter usually catches
 *      it — but if the recent-write window has lapsed by the time the
 *      OS coalesces the event, this guard is the second line of
 *      defense.
 *   2. {@link buildKnownDocForExternalPath} returns null → ignore.
 *      The file is in an unrecognised location (`screenshots/foo.md`,
 *      a writing under a daily that isn't on disk, etc.) — same
 *      filter scanVault uses at boot.
 *   3. Otherwise → push the new KnownDoc into the catalog. The
 *      sidebar selector re-renders on the next zustand notify and
 *      the doc appears under its placement group.
 */
/** Pure move-correlation: given the body-hashes of currently-open docs and
 * the newly-appeared file's body-hash, return the slug of the open doc that
 * was moved/renamed here (content match), or null. Extracted so the
 * correlation is unit-testable without the fs event stream. */
export function matchMovedDoc(
  openDocHashes: ReadonlyArray<{ slug: string; hash: string }>,
  newBodyHash: string,
): string | null {
  const hit = openDocHashes.find((d) => d.hash === newBodyHash)
  return hit ? hit.slug : null
}

/** A file appeared at `rel`. Find an OPEN doc whose live body matches it —
 * that doc was moved/renamed here from another path. Only open docs (a live
 * handle with `bodyMarkdown`) can be correlated, which is exactly the set
 * with a tab/handle worth preserving; a closed doc being moved has no tab to
 * lose. Both sides hash BODY-ONLY (the new file carries a frontmatter block,
 * `bodyMarkdown` doesn't). Returns the moved doc's slug, or null.
 *
 * Order-independent: the remove leg defers its delete 150ms, so the old doc
 * is still in the catalog (with its handle) whether the add or remove event
 * arrives first — this scan finds it either way. The dirty case is the one
 * miss: an open doc with unsaved edits has `bodyMarkdown` ≠ its on-disk
 * bytes, so a raw move won't hash-match and falls back to add. */
async function findMovedOpenDocSlug(rel: string): Promise<string | null> {
  let body: string
  try {
    body = splitFrontmatter(await readVaultFile(rel)).body
  } catch {
    return null
  }
  // An empty/whitespace-only body hash-matches every other empty doc (e.g. a
  // freshly created untitled tab), which would wrongly correlate an unrelated
  // new external file as a move. Skip correlation and fall back to add.
  if (body.trim() === '') return null
  const newHash = await hashContent(body)
  const { handles } = useDocsStore.getState()
  // Deliberately the MIRROR (`h.bodyMarkdown`, ≈ last-flushed disk bytes), NOT
  // `readDocBody` (the live editor): a file move copies on-disk bytes, so we
  // correlate against disk-ish state. A dirty open doc's live body wouldn't match
  // the moved file anyway (see the dirty-case note above) → falls back to add.
  const openDocHashes = await Promise.all(
    Object.entries(handles)
      .filter((e): e is [string, NonNullable<(typeof e)[1]>] => !!e[1])
      .map(async ([slug, h]) => ({ slug, hash: await hashContent(h.bodyMarkdown) })),
  )
  return matchMovedDoc(openDocHashes, newHash)
}

function handleExternalAdd(rel: string): void {
  // Track the new file for the next commit so a sidecar-created wiki
  // page (or one made by an external tool like Obsidian) flows into
  // git history. Same idempotent path as handleExternalReload.
  if (isActivityPath(rel)) {
    useGitStore.getState().noteActivity(rel)
  }
  const state = useDocsStore.getState()
  if (findSlugByVaultPath(state.knownDocs, rel)) return
  void (async () => {
    // Move/rename correlation (VS Code-style): if an OPEN doc's body matches
    // the new file, it was moved here. Reuse its slug via updateKnownDocPath
    // so the tab + handle follow, and cancel the remove leg's pending delete
    // (its path re-check would otherwise fire). This replaces the pre-Phase-2
    // frontmatter-slug match, which broke once mint stopped recovering slugs.
    const movedSlug = await findMovedOpenDocSlug(rel)
    if (movedSlug) {
      cancelPendingRemove(movedSlug)
      const title = rel.split('/').pop()!.replace(/\.md$/, '')
      useDocsStore.getState().updateKnownDocPath(movedSlug, rel, title)
      console.log('[vault:move] open tab followed', { rel, slug: movedSlug })
      return
    }
    // Genuine new file → build + add (or the planReappear update/noop echo
    // race for a doc that reappears at a path already mapped to its slug).
    const doc = await buildKnownDocForExternalPath(rel, useDocsStore.getState().knownDocs)
    if (!doc) return
    const live = useDocsStore.getState()
    const existing = live.knownDocs.find((d) => d.slug === doc.slug)
    const plan = planReappear(existing, doc)
    if (plan.kind === 'add') {
      console.log('[vault:add] external doc added', { rel, slug: doc.slug })
      live.addKnownDoc(doc)
      return
    }
    cancelPendingRemove(doc.slug)
    if (plan.kind === 'update') {
      live.updateKnownDocPath(doc.slug, plan.relPath, plan.title)
    }
  })().catch((err) => {
    console.warn('[vault:add] failed to process external add', { rel, err })
  })
}

/** A watched `.md` disappeared from disk. Decision tree:
 *
 *   1. Path doesn't map to any known slug → ignore. Either an
 *      unrecognised file we never tracked, or the matching half of an
 *      atomic-write rename whose `add` leg already reached us.
 *   2. Otherwise → `removeKnownDoc(slug)`. The action closes the tab
 *      (if any), tears down the ydoc, scrubs handles/status, and
 *      drops the slug from knownDocs + expandedDocSlugs in one go.
 *
 * Obsidian / iA Writer convention: external deletion is a direct
 * user action, so we trust it even when the local doc had unsaved
 * edits. The user moved the file to the trash deliberately; second-
 * guessing them with a confirm dialog would feel paternalistic.
 */
/** One leg of an external move/rename. macOS notify names a single
 * path per `rename` event with `mode: 'any'`, so the event itself
 * can't say whether this path is the move's source or destination —
 * we disambiguate by disk presence:
 *
 *   - exists now  → destination. Route like a create: `handleExternalAdd`
 *     matches the file's frontmatter slug to the open doc and swaps its
 *     relPath in place (tab + handle survive), or adds a brand-new doc.
 *   - gone now     → source. Route like a delete: `handleExternalRemove`
 *     defers removal so the destination leg can cancel it — turning the
 *     two events back into a single "moved" rather than "deleted + added".
 *
 * The two legs can arrive in either order; the add/remove handlers'
 * existing pending-remove coalescing makes the result order-independent. */
async function handleExternalRename(rel: string): Promise<void> {
  if (renameLeg(await vaultFileExists(rel)) === 'add') {
    handleExternalAdd(rel)
  } else {
    handleExternalRemove(rel)
  }
}

/** Pending deletes, keyed by slug. A remove event schedules one; a
 * matching add (the other half of a move) cancels it. */
const pendingRemove = new Map<string, ReturnType<typeof setTimeout>>()
function cancelPendingRemove(slug: string): void {
  const t = pendingRemove.get(slug)
  if (t) {
    clearTimeout(t)
    pendingRemove.delete(slug)
  }
}

function handleExternalRemove(rel: string): void {
  // A deletion is still an activity — `git add -A` in the next commit
  // will turn the missing file into a `D` change. We note it so the
  // commit happens at all (otherwise dirtyPaths stays empty and the
  // chat-turn commit gate skips).
  if (isActivityPath(rel)) {
    useGitStore.getState().noteActivity(rel)
  }
  const state = useDocsStore.getState()
  const slug = findSlugByVaultPath(state.knownDocs, rel)
  if (!slug) return
  // A move/rename fires remove(old)+add(new) with the SAME slug. Don't
  // delete immediately — defer briefly. If the note reappears (the add
  // leg updates its relPath in place), it's a move, not a delete. We
  // re-check by path so the remove/add order doesn't matter: only
  // delete if the doc still resolves to the removed path.
  cancelPendingRemove(slug)
  pendingRemove.set(
    slug,
    setTimeout(() => {
      pendingRemove.delete(slug)
      const live = useDocsStore.getState()
      const doc = live.knownDocs.find((d) => d.slug === slug)
      if (!doc) return
      const bySlug = new Map(live.knownDocs.map((d) => [d.slug, d]))
      if (pathForDoc(doc, (s) => bySlug.get(s)) === rel) {
        console.log('[vault:remove] external doc removed', { rel, slug })
        live.removeKnownDoc(slug)
      }
    }, 150),
  )
}

/** True for vault-relative paths the router should process.
 *
 * Flat vault: EVERY `.md` anywhere in the vault is a note, so external
 * adds/edits/deletes in arbitrary user folders (articles/, projects/,
 * the root, …) must sync live — not just the old four system folders.
 * (Echo suppression is content-hash based, so our own writes in any
 * folder are still filtered before reaching the handlers.)
 *
 * Excludes:
 *   - non-`.md` (sidecars `.meta.json`, atomic-write `.md.tmp`, etc.),
 *   - anything inside a dot-dir (`.git/`, `.obsidian/`) — noise. */
function isWatchableBodyFile(rel: string): boolean {
  if (!rel.endsWith('.md')) return false
  return !rel.split('/').some((seg) => seg.startsWith('.'))
}

/** True for vault-relative paths that are rendered HTML artifacts. Same
 * dot-segment exclusion as `isWatchableBodyFile` — a `.html` inside `.git/` or
 * `.octave/` is app or tool noise, not something the user is looking at.
 *
 * Exported so the test calls this predicate instead of restating the extension
 * rule; a copy in the test is how the two drift. */
export function isWatchableArtifactFile(rel: string): boolean {
  if (!/\.html?$/i.test(rel)) return false
  return !rel.split('/').some((seg) => seg.startsWith('.'))
}

// Dev-only console handle for manual testing.
//   __vaultWatcher.start()
//   __vaultWatcher.stop()
if (import.meta.env.DEV) {
  ;(window as unknown as {
    __vaultWatcher: {
      start: typeof startVaultWatcher
      stop: typeof stopVaultWatcher
    }
  }).__vaultWatcher = {
    start: startVaultWatcher,
    stop: stopVaultWatcher,
  }
}
