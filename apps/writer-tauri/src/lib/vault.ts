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
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import { dirname, join } from '@tauri-apps/api/path'
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

/** Window (ms) during which a content-hash we recently wrote stays
 * in the echo-suppression set. macOS fsevents can coalesce + delay
 * events under load by 1-3 seconds, so the window must comfortably
 * cover that. The cost of a false negative (genuine external edit
 * with identical bytes suppressed) is essentially zero — if the
 * external edit produced the same content, there's no functional
 * difference to "our own write". The cost of a false positive (our
 * own write looks external) is much higher — a reload would wipe
 * in-memory state. */
const RECENT_WRITE_WINDOW_MS = 30_000

/** Track content hashes of recent writes. Echo suppression compares
 * the *bytes on disk at event time* to the bytes we just wrote — so
 * path differences (canonicalisation, symlinks, trailing slashes)
 * stop mattering. Same byte content → same hash → suppressed. The
 * VS Code approach. */
const recentWriteHashes = new Map<string, number>()

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Web Crypto types BufferSource as `ArrayBuffer | ArrayBufferView<ArrayBuffer>`.
  // `Uint8Array<ArrayBufferLike>` (the modern TS lib signature) isn't a
  // direct match because the underlying buffer could be SharedArrayBuffer.
  // We control the input — it always comes from a regular ArrayBuffer —
  // so the cast is safe.
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as BufferSource,
  )
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Record the hash of bytes we just wrote so the watcher can
 * recognise the resulting fsevent as our own and suppress it.
 * Called from inside each `writeVault*` helper *before* the actual
 * write hits disk, so the hash is in place by the time the OS
 * delivers the resulting event. */
async function markOurRecentContent(bytes: Uint8Array): Promise<void> {
  const hash = await sha256Hex(bytes)
  recentWriteHashes.set(hash, Date.now())
}

/** Did the on-disk content at `relPath` come from one of our recent
 * writes? Reads the file, computes its hash, and checks the recent
 * set. Async because it touches disk.
 *
 * Stale entries are lazily pruned on read so the Map doesn't grow
 * unbounded over long sessions. */
export async function isOurRecentWrite(relPath: string): Promise<boolean> {
  try {
    const path = await resolveVaultPath(relPath)
    const bytes = await readFile(path)
    const hash = await sha256Hex(bytes)
    const t = recentWriteHashes.get(hash)
    if (t === undefined) return false
    if (Date.now() - t > RECENT_WRITE_WINDOW_MS) {
      recentWriteHashes.delete(hash)
      return false
    }
    return true
  } catch {
    // File doesn't exist or read failed — can't be our recent write.
    return false
  }
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
  // Ensure the parent directory exists. Nested doc layouts —
  // `daily/2026-05-18/note.md`, future `wiki/<area>/<page>.md` — write
  // into folders that aren't part of the four root subdirs ensured at
  // vault creation. `recursive: true` is a no-op when the path already
  // exists, so this stays idempotent on the common steady-state write.
  const parent = await dirname(path)
  await mkdir(parent, { recursive: true })
  await markOurRecentContent(new TextEncoder().encode(content))
  await atomicWriteText(path, content)
}

/** Append UTF-8 text to a vault file, creating it if missing.
 *
 * Unlike {@link writeVaultFile}, this is NOT a tmp+rename atomic
 * write — the kernel appends the bytes directly to the existing file.
 * That's the right semantics for append-only logs (chat turn JSONL,
 * future ingest logs) where:
 *
 *   - a full rewrite would scale O(n) with the file size on every
 *     turn, which is unacceptable for long threads
 *   - the crash mode we care about is "lose the last partial write",
 *     not "corrupt the existing content" — append never touches
 *     bytes already on disk
 *
 * POSIX guarantees an append-mode write of ≤ PIPE_BUF bytes (4096 on
 * Linux, larger on macOS) is atomic against concurrent writers to the
 * same fd. We're a single-writer process, so the stronger guarantee
 * we actually need — "the file never contains a half-written byte
 * sequence" — comes from the OS serialising our own writes. Callers
 * that append multi-KB payloads (a long assistant turn) should still
 * write a single full line at a time so the file remains parseable
 * line-by-line after any crash.
 *
 * Like the atomic helpers, the path is stamped into
 * {@link recentWrites} so the file watcher ignores the resulting
 * fsevent. */
export async function appendVaultFile(
  relPath: string,
  content: string,
): Promise<void> {
  const path = await resolveVaultPath(relPath)
  const parent = await dirname(path)
  await mkdir(parent, { recursive: true })
  // With content-hash echo we need the post-append bytes to mark
  // before the write lands. Read existing, concatenate, mark, write
  // atomically. Loses the "OS-level append" semantics but our chat
  // threads are O(KB) so the read-modify-write cost is negligible.
  let existing: Uint8Array
  try {
    existing = await readFile(path)
  } catch {
    existing = new Uint8Array(0)
  }
  const appendBytes = new TextEncoder().encode(content)
  const combined = new Uint8Array(existing.length + appendBytes.length)
  combined.set(existing)
  combined.set(appendBytes, existing.length)
  await markOurRecentContent(combined)
  await writeTextFile(path, new TextDecoder().decode(combined))
}

/** Atomic binary write — same tmp+rename pattern as
 * {@link atomicWriteText} but for Uint8Array payloads (Y.Doc updates,
 * binary sidecars). Splitting the two helpers means we don't pay a
 * UTF-8 encoding round trip for binary content and don't risk
 * accidental TextEncoder mangling. */
async function atomicWriteBinary(absPath: string, data: Uint8Array): Promise<void> {
  const tmp = `${absPath}.tmp`
  await writeFile(tmp, data)
  try {
    await rename(tmp, absPath)
  } catch (err) {
    try {
      await remove(tmp)
    } catch {
      // ignore
    }
    throw err
  }
}

/** Write a vault file as raw bytes, atomically. Used for the `.ydoc`
 * sidecar (Yjs state binary) where text encoding would corrupt the
 * payload. Same parent-mkdir + recent-write tagging as
 * {@link writeVaultFile}. */
export async function writeVaultBinary(
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  const path = await resolveVaultPath(relPath)
  const parent = await dirname(path)
  await mkdir(parent, { recursive: true })
  await markOurRecentContent(data)
  await atomicWriteBinary(path, data)
}

/** Read a vault file as raw bytes. Used for the `.ydoc` sidecar
 * (Yjs state binary). */
export async function readVaultBinary(relPath: string): Promise<Uint8Array> {
  const path = await resolveVaultPath(relPath)
  return await readFile(path)
}

/** Move a vault file from one relative path to another. Used by the
 * rename-on-title-change path so a doc whose filename changes keeps
 * the same on-disk identity (same approach Obsidian / VS Code use).
 * Without this, every title edit would create a fresh file and
 * orphan the old one.
 *
 * Both the source and destination get marked in {@link recentWrites}
 * so the future file watcher's echo filter suppresses both events. */
export async function renameVaultFile(
  fromRel: string,
  toRel: string,
): Promise<void> {
  const fromAbs = await resolveVaultPath(fromRel)
  const toAbs = await resolveVaultPath(toRel)
  const parent = await dirname(toAbs)
  await mkdir(parent, { recursive: true })
  // Pre-mark the file's content so the rename's fsevent is recognised
  // as ours. Rename doesn't change content, so the same hash matches
  // events for both the source removal and the destination creation.
  try {
    const bytes = await readFile(fromAbs)
    await markOurRecentContent(bytes)
  } catch {
    // If we can't read the source, the rename will fail anyway and
    // there are no events to suppress.
  }
  await rename(fromAbs, toAbs)
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
