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
//   - atomic write (write-tmp-then-rename) — Phase 4.A Step 5
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

/** Write a vault file as UTF-8 text. Overwrites if the file exists.
 * Phase 4.A Step 5 will add an atomic variant; for now this is a
 * direct overwrite (good enough for individual page saves where the
 * worst case is a partial write on app crash). */
export async function writeVaultFile(relPath: string, content: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  await writeTextFile(path, content)
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
  }
}
