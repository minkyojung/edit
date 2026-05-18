/**
 * Vault folder watcher — Phase 4.E.1 (logging-only baseline).
 *
 * Listens to the OS file-system event stream for the active vault
 * folder and prints filtered events to the console. NO mutations
 * happen here yet — this scaffold exists so we can:
 *
 *   1. Verify the Tauri plugin-fs `watch` API actually fires events
 *      for our vault on macOS (the dev platform).
 *   2. Observe the shape of those events (paths, action types,
 *      timing) to inform the router design in Phase 4.E.2.
 *   3. Validate that the existing `isOurRecentWrite()` echo filter
 *      from `vault.ts` correctly suppresses fsevents triggered by
 *      our own writes — without that, every flushDirty tick would
 *      ping-pong as an "external change".
 *
 * Lifecycle:
 *   - `startVaultWatcher()` — called once at app boot, gated on
 *     `getActiveVaultPath()`. Returns the dispose function so the
 *     caller (App.tsx) can clean up on teardown.
 *   - Returns no-op when no vault is selected (vault picker hasn't
 *     run yet). Caller should re-invoke after picker completes —
 *     wiring for that lives in Phase 4.E.2.
 *
 * Out of scope for this phase:
 *   - Re-loading Y.Doc on external edit
 *   - Adding / removing knownDocs on external file create / delete
 *   - Conflict UI when app is editing a doc that gets modified
 *   - Debouncing event bursts (git checkout, batch rename)
 */

import { watch } from '@tauri-apps/plugin-fs'
import { getActiveVaultPath } from '@/state/settingsStore'
import { isOurRecentWrite } from './vault'

let activeUnwatch: (() => void) | null = null

/** Start watching the active vault. Returns a disposer; calling it
 * (or `stopVaultWatcher`) tears the watcher down. Safe to call
 * repeatedly — re-invocation replaces the existing watcher. */
export async function startVaultWatcher(): Promise<() => void> {
  // Tear down any previous watcher so a vault-path change (future
  // settings-panel feature) doesn't leave stale watchers running.
  stopVaultWatcher()

  const vaultPath = getActiveVaultPath()
  if (!vaultPath) {
    console.log('[watch] no vault selected; watcher inert')
    return () => {}
  }

  console.log('[watch] starting on', vaultPath)
  const unwatch = await watch(
    vaultPath,
    (event) => {
      // Tauri's `watch` callback fires for every fsevent. On macOS
      // the event shape is `{ type: { create: {...} | modify: {...} | remove: {...} }, paths: [...] }`.
      // Paths can be either vault-relative (most events) or absolute
      // (whole-dir metadata pings) — `toVaultRelative` normalises.
      if (!isActionableEvent(event)) return

      const rawPaths = Array.isArray(event.paths) ? event.paths : []
      const relPaths = rawPaths.map((p) => toVaultRelative(p, vaultPath))

      // Keep only paths that are interesting body files (`.md` inside
      // `wiki/`, `daily/`, or `_system/`). Everything else is either:
      //   - an app-internal sidecar (`.meta.json`, `.ydoc`) that the
      //     user shouldn't be editing directly
      //   - a tmp companion of the atomic write (`.md.tmp`, etc.)
      //   - a directory entry (no concrete file to load)
      const candidates = relPaths.filter(isWatchableBodyFile)
      if (candidates.length === 0) return

      // Filter self-echo: paths we recently wrote ourselves. Without
      // this every flushDirty tick would appear as an "external
      // change" and we'd reload the doc we just saved.
      const external = candidates.filter((rel) => !isOurRecentWrite(rel))
      if (external.length === 0) {
        // Temporary debug — confirm the echo filter is doing work.
        // Remove once Phase 4.E.1 is stable.
        console.log('[watch] echo suppressed', candidates)
        return
      }

      dispatchEvent(event, external)
    },
    { recursive: true },
  )
  activeUnwatch = unwatch
  return unwatch
}

/** Stop the active vault watcher if any. Idempotent. */
export function stopVaultWatcher(): void {
  if (activeUnwatch) {
    activeUnwatch()
    activeUnwatch = null
  }
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

  if ('create' in type && type.create) {
    for (const rel of paths) handleExternalAdd(rel)
    return
  }
  if ('remove' in type && type.remove) {
    for (const rel of paths) handleExternalRemove(rel)
    return
  }
  if ('modify' in type && type.modify) {
    // `kind: 'data'` is the only modify variant that reaches here —
    // `isActionableEvent` already filtered out `metadata`. A future
    // `rename` kind would also land in `modify`; route it to add /
    // remove based on shape when Phase 4.E.3 needs it.
    for (const rel of paths) handleExternalReload(rel)
    return
  }
}

/** Stub: external write detected on an existing .md. In Phase 4.E.3
 * this will reload the file's Y.Doc when the doc is currently open,
 * or invalidate its cached body when it isn't. */
function handleExternalReload(rel: string): void {
  console.log('[router] reload candidate:', rel)
}

/** Stub: a new .md appeared under a watched subtree. In Phase 4.E.3
 * this will read its `.meta.json` (or synthesise one) and add the
 * doc to `knownDocs` so it shows up in the sidebar without a full
 * scanVault re-run. */
function handleExternalAdd(rel: string): void {
  console.log('[router] add candidate:', rel)
}

/** Stub: a watched .md disappeared. In Phase 4.E.3 this will remove
 * the doc from `knownDocs` (and close its tab if open). Trash /
 * archive flows go through the app and are filtered by the echo
 * guard before reaching here. */
function handleExternalRemove(rel: string): void {
  console.log('[router] remove candidate:', rel)
}

/** True for vault-relative paths we want the router to consider.
 *
 * Only `.md` body files inside the four placement subdirectories
 * (`wiki/`, `daily/`, `_system/`, `threads/`) are interesting:
 *
 *   - `.meta.json` / `.ydoc` are app-internal sidecars; users
 *     don't edit them directly, and atomic-write tmp variants
 *     also share their suffix.
 *   - `.md.tmp` is leaked by the atomic-write pattern; the echo
 *     filter catches it but this gate is a defensive double-check.
 *   - Bare directory names (no extension) fire on metadata pings.
 *
 * Phase 4.E.2's router will use the same predicate to classify
 * what to do with each `.md`. */
function isWatchableBodyFile(rel: string): boolean {
  if (!rel.endsWith('.md')) return false
  return (
    rel.startsWith('wiki/') ||
    rel.startsWith('daily/') ||
    rel.startsWith('_system/') ||
    rel.startsWith('threads/')
  )
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
