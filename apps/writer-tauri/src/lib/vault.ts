// Vault file I/O — the single entry point for reading and writing
// anything inside the user's chosen vault folder.
//
// Phase 4 makes the vault the source of truth for wiki / daily /
// system pages. Every other module that needs filesystem access goes
// through these helpers so:
//
//   - the active vault path lookup lives in one place (no scattered
//     `getActiveVaultPath()` calls + manual joining)
//   - relative paths are validated (no `..` escape, no absolute
//     prefixes) — the rest of the app can pass `'wiki/Tom.md'` and
//     trust the helper to keep the I/O inside the vault scope
//   - the Tauri plugin-fs surface is wrapped once, so a future
//     change of underlying primitive (e.g. switching to a native
//     command for atomic writes) is a one-file change
//
// Out of scope for this file:
//   - file watcher (external change detection)  — Phase 4.E
//   - mark sidecar JSON shape                   — Phase 4.C
//
// All `relPath` arguments are relative to the vault root, written
// with forward slashes (`'wiki/Tom.md'`). The helper normalises
// them to the platform's separator via Tauri's path.join.

import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'

/** Four subdirectories the app expects inside a vault. Created on
 * first run via {@link ensureVaultStructure}. */
export const VAULT_SUBDIRS = ['wiki', 'daily', '_system', 'threads'] as const

/** Custom error thrown when no vault has been selected. Callers
 * gate on {@link getActiveVaultPath} before calling these helpers,
 * but this surface preserves a clear error type for the rare race
 * (e.g. user resets the vault while a write is in flight). */
export class NoVaultSelectedError extends Error {
  constructor() {
    super('No vault selected. Call pickVault() first.')
    this.name = 'NoVaultSelectedError'
  }
}

/** Reject path-traversal attempts and absolute prefixes. Relative
 * vault paths must be `<dir>/<name>` or `<name>` only. The defence
 * isn't security-critical (the user owns the host machine anyway),
 * but it surfaces bugs early — a caller passing an absolute path
 * is almost certainly a coding error that would otherwise silently
 * write outside the vault. */
function assertSafeRelPath(relPath: string): void {
  if (relPath === '' || relPath === '/') {
    throw new Error(`Invalid vault relPath: ${JSON.stringify(relPath)}`)
  }
  if (relPath.startsWith('/') || relPath.match(/^[a-zA-Z]:[\\/]/)) {
    throw new Error(`Vault relPath must be relative, got: ${relPath}`)
  }
  // Block "..": `wiki/../etc/passwd` etc. Allow `..` inside file
  // names (rare; not blocked) — only segment-level `..` is unsafe.
  const segments = relPath.split(/[\\/]/)
  if (segments.includes('..')) {
    throw new Error(`Vault relPath must not contain '..' segments: ${relPath}`)
  }
}

/** Resolve a vault-relative path to its absolute filesystem path.
 * Throws {@link NoVaultSelectedError} when no vault has been picked. */
async function resolveVaultPath(relPath: string): Promise<string> {
  assertSafeRelPath(relPath)
  const root = getActiveVaultPath()
  if (!root) throw new NoVaultSelectedError()
  return await join(root, relPath)
}

/** Ensure the vault root + the four standard subdirectories exist.
 * Idempotent: `mkdir({ recursive: true })` is a no-op when the
 * directory is already there. Call once at boot after the user
 * picks a vault. */
export async function ensureVaultStructure(): Promise<void> {
  const root = getActiveVaultPath()
  if (!root) throw new NoVaultSelectedError()
  await mkdir(root, { recursive: true })
  for (const sub of VAULT_SUBDIRS) {
    const path = await join(root, sub)
    await mkdir(path, { recursive: true })
  }
}

/** Read a vault file as UTF-8 text. */
export async function readVaultFile(relPath: string): Promise<string> {
  const path = await resolveVaultPath(relPath)
  return await readTextFile(path)
}

/** Window (ms) during which a file we just wrote should be treated as
 * "our recent write" by file-watcher consumers. Generous compared to
 * typical write+rename latency (~20ms) and fsevents propagation
 * (~100ms) so we don't miss echoes on a slow disk; short enough that
 * a genuine external edit landing right after our save isn't
 * suppressed. Tune if echoes start leaking through. */
const RECENT_WRITE_WINDOW_MS = 1000

/** Track the timestamp of each vault path we recently wrote so the
 * file watcher (Phase 4.E) can ignore the resulting echo events.
 * Without this filter our own writes would fire the "external
 * change" path and either trigger noisy reload, an unsaved-changes
 * modal, or in the worst case an infinite write→event→write loop. */
const recentWrites = new Map<string, number>()

function markOurRecentWrite(relPath: string): void {
  recentWrites.set(relPath, Date.now())
}

/** Did we write `relPath` within the recent-write window? Used by
 * the file watcher (and tests) to filter echo events. Lazily prunes
 * stale entries so the Map doesn't grow unbounded over a long
 * session. */
export function isOurRecentWrite(relPath: string): boolean {
  const t = recentWrites.get(relPath)
  if (t === undefined) return false
  if (Date.now() - t > RECENT_WRITE_WINDOW_MS) {
    recentWrites.delete(relPath)
    return false
  }
  return true
}

/** Atomic file write — content lands on disk as a complete file or
 * not at all, never as a half-written partial.
 *
 * Strategy: write everything to a sibling `<path>.tmp` first, then
 * atomically rename it over the destination. POSIX rename(2) is
 * atomic when the two paths share a filesystem (which they do here
 * — sibling files in the same directory).
 *
 * If the rename fails after a successful tmp write, the tmp file is
 * cleaned up so the vault doesn't accumulate `.tmp` cruft. The
 * `recentWrites` flag is set BEFORE rename so the watcher event for
 * the rename is reliably caught — see comment on
 * RECENT_WRITE_WINDOW_MS for the timing budget. */
async function atomicWriteText(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp`
  await writeTextFile(tmp, content)
  try {
    await rename(tmp, absPath)
  } catch (err) {
    // Best-effort cleanup so a failed rename doesn't litter the
    // vault. Swallow secondary errors — the primary failure is what
    // the caller needs to see.
    try {
      await remove(tmp)
    } catch {
      // ignore
    }
    throw err
  }
}

/** Write a vault file as UTF-8 text, atomically. Existing file is
 * replaced as one operation — consumers never see a partial write
 * even if the process crashes mid-rename. Also stamps the path into
 * {@link recentWrites} so the file watcher's echo filter
 * ({@link isOurRecentWrite}) can suppress the inevitable fsevents
 * fire that follows. */
export async function writeVaultFile(relPath: string, content: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  markOurRecentWrite(relPath)
  await atomicWriteText(path, content)
}

/** List entries (files + directories) inside a vault directory.
 * Returns names only (not full paths) for consistency with how the
 * sidebar / file tree consumers read them. Pass `''` to list the
 * vault root.
 *
 * Hidden entries (starting with `.`) are filtered — `.DS_Store`,
 * `.git/`, etc. shouldn't surface in the app's file browser. The
 * `_system/` directory is NOT filtered (underscore-prefixed, not
 * dot-prefixed) — it's a vault-defined hidden-ish convention that
 * callers decide whether to show. */
export async function listVaultDir(relPath: string): Promise<string[]> {
  // Special-case the root: '' isn't a valid relPath to resolve, but
  // it's the natural way to ask "list the vault root".
  let path: string
  if (relPath === '') {
    const root = getActiveVaultPath()
    if (!root) throw new NoVaultSelectedError()
    path = root
  } else {
    path = await resolveVaultPath(relPath)
  }
  const entries = await readDir(path)
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => e.name)
}

/** Does the given vault-relative path exist (file OR directory)? */
export async function vaultFileExists(relPath: string): Promise<boolean> {
  const path = await resolveVaultPath(relPath)
  return await exists(path)
}

/** Delete a vault file. No-op if it doesn't exist. */
export async function deleteVaultFile(relPath: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  if (await exists(path)) {
    await remove(path)
  }
}

// Dev-only console handle. Open DevTools, run e.g.
//   await __vault.ensureStructure()
//   await __vault.write('wiki/Test.md', '# Hello')
//   await __vault.read('wiki/Test.md')
//   await __vault.list('wiki')
if (import.meta.env.DEV) {
  ;(window as unknown as { __vault: Record<string, unknown> }).__vault = {
    ensureStructure: ensureVaultStructure,
    read: readVaultFile,
    write: writeVaultFile,
    list: listVaultDir,
    exists: vaultFileExists,
    delete: deleteVaultFile,
    isRecentWrite: isOurRecentWrite,
  }
}
