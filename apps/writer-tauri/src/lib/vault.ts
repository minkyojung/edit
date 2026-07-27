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
import { invoke } from '@tauri-apps/api/core'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useGitStore } from '@/state/gitStore'
import { open as openInDefaultApp } from '@tauri-apps/plugin-shell'
import { isAttachmentFile } from './attachments'

/** Tell the git layer that a path was just modified. This is an
 * **activity signal**, not a commit trigger — the gitStore decides
 * when to actually commit based on idle / ceiling / blur boundaries
 * (see gitStore for the timing model). Safe to call from inside the
 * write helpers; git operations happen async on the gitStore's
 * timers, so the write path stays fast. */
function scheduleAutoCommit(relPath: string): void {
  // gitStore actions are sync; the actual git commit runs when the
  // edit session ends (idle / blur / ceiling). Wrapping in try
  // keeps a missing git binary or a not-yet-initialised repo from
  // breaking writes — the editor keeps working, the user just
  // doesn't get auto-history.
  try {
    useGitStore.getState().noteActivity(relPath)
  } catch (err) {
    console.warn('[vault] scheduleAutoCommit failed', err)
  }
}

/** Four subdirectories the app expects inside a vault. Created on
 * first run via {@link ensureVaultStructure}. */
// `threads` and attachments are NOT scaffolded here — they live under the
// hidden `.octave/` namespace and are created lazily on first write (same as
// `.attachments/` always was), which also keeps the one-time octave migration
// from racing an eagerly-created empty destination.
export const VAULT_SUBDIRS = ['wiki', 'daily', '_system'] as const

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

/** Absolute filesystem path for a vault-relative path. For UI actions
 * that hand a real path to the OS (open in default app, reveal in
 * Finder, copy path). */
export async function vaultAbsPath(relPath: string): Promise<string> {
  return resolveVaultPath(relPath)
}

/** Open a vault file in the OS default app. Resolves the absolute path
 * (with the same `..`-rejecting validation as every vault read) and hands
 * it to the shell. Throws on failure — callers add their own logging. */
export async function openVaultFile(relPath: string): Promise<void> {
  await openInDefaultApp(await vaultAbsPath(relPath))
}

/** Reveal a vault file in Finder (selects it in its enclosing folder). */
export async function revealVaultFile(relPath: string): Promise<void> {
  await invoke('reveal_in_finder', { path: await vaultAbsPath(relPath) })
}

/** What we believe each file currently contains, as a content hash, keyed by
 * vault-relative path. One value per path — the LATEST — never a history.
 *
 * This is the echo filter: an fsevent whose on-disk content already matches our
 * belief has nothing to tell us, so it's dropped. Our own writes are recognised
 * for free, because writing is exactly when the belief is updated.
 *
 * It replaces a set of every hash written in the last 30 seconds, which was
 * unsound rather than merely imprecise. A *history* of contents we once wrote
 * overlaps the contents an external tool may legitimately restore — and
 * restoring an earlier version is precisely what version control does for a
 * living. So `git revert`, or the undo-ai-change skill, could put back a body
 * we'd written seconds earlier and the event would be swallowed: the editor
 * kept the newer text and the next flush wrote it back, undoing the undo. No
 * window fixes that, because tolerating coalesced fsevents wants a LONG window
 * and not swallowing a revert wants a SHORT one. Neither VS Code, Zed, nor Git
 * has such a window; all three compare against one current token (VS Code's
 * `lastResolvedFileStat.etag`, Zed's `DiskState { mtime, size }`, Git's stat
 * cache with a content-comparison backstop).
 *
 * Keyed by PATH, which the hash set was not: it matched content anywhere, so a
 * write of some bytes to one file suppressed an external write of the same
 * bytes to another. */
const knownDiskHashes = new Map<string, string>()

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

/** Hash arbitrary UTF-8 text (a doc's body) for the watcher's move/rename
 * correlation — same SHA-256 the echo layer uses. Body-only on both sides:
 * an external move fires remove(old)+add(new); the removed doc's live body
 * (`handle.bodyMarkdown`, frontmatter already stripped) is hashed against the
 * new file's `splitFrontmatter(raw).body`, so the surrogate slug can follow
 * the file instead of being re-minted. */
export async function hashContent(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text))
}

/** Record what we now believe `relPath` contains. Called from inside each
 * `writeVault*` helper *before* the write hits disk, so the belief is in place
 * by the time the OS delivers the resulting event. */
async function noteDiskContent(relPath: string, bytes: Uint8Array): Promise<void> {
  knownDiskHashes.set(relPath, await sha256Hex(bytes))
}

/** Did the on-disk content at `relPath` come from one of our recent
 * writes? Reads the file, hashes the bytes, checks against the
 * recent-write hash set. Async because it touches disk.
 *
 * Stale entries are lazily pruned on read so the Map doesn't grow
 * unbounded over long sessions. */
export async function isDiskContentKnown(relPath: string): Promise<boolean> {
  try {
    const bytes = await readFile(await resolveVaultPath(relPath))
    const hash = await sha256Hex(bytes)
    if (knownDiskHashes.get(relPath) === hash) return true
    // Disk holds something we didn't know about: a real change. Adopt it as the
    // new belief so a coalesced duplicate of the same event doesn't dispatch
    // twice — the caller is about to handle this content.
    knownDiskHashes.set(relPath, hash)
    return false
  } catch {
    // Gone or unreadable — nothing to compare, so it isn't a match. Forget the
    // belief; a file recreated later must not be mistaken for still-known.
    knownDiskHashes.delete(relPath)
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
 * Our belief about the file's content is recorded BEFORE the rename, so it is
 * already in place when the OS delivers the resulting event. */
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
 * even if the process crashes mid-rename. Also records what we now believe the
 * file holds ({@link isDiskContentKnown}) so the file watcher drops the
 * inevitable fsevent that follows. */
export async function writeVaultFile(relPath: string, content: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  // Ensure the parent directory exists. Nested doc layouts —
  // `daily/2026-05-18/note.md`, future `wiki/<area>/<page>.md` — write
  // into folders that aren't part of the four root subdirs ensured at
  // vault creation. `recursive: true` is a no-op when the path already
  // exists, so this stays idempotent on the common steady-state write.
  const parent = await dirname(path)
  await mkdir(parent, { recursive: true })
  await noteDiskContent(relPath, new TextEncoder().encode(content))
  await atomicWriteText(path, content)
  scheduleAutoCommit(relPath)
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
 * Like the atomic helpers, it records what the file now holds so the watcher
 * ignores the resulting fsevent. */
export async function appendVaultFile(
  relPath: string,
  content: string,
): Promise<void> {
  const path = await resolveVaultPath(relPath)
  const parent = await dirname(path)
  await mkdir(parent, { recursive: true })
  // We need the post-append bytes to record as our belief before the write
  // lands. Read existing, concatenate, mark, write
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
  await noteDiskContent(relPath, combined)
  await writeTextFile(path, new TextDecoder().decode(combined))
  scheduleAutoCommit(relPath)
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
  await noteDiskContent(relPath, data)
  await atomicWriteBinary(path, data)
  // .ydoc files are gitignored so this debounce will mostly resolve
  // to a no-op commit, but image / video / audio binaries (the other
  // callers of writeVaultBinary) DO want history — schedule
  // unconditionally and let git's exclude filter decide.
  scheduleAutoCommit(relPath)
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
 * The destination's belief is carried over so the resulting fsevent is
 * recognised as ours; see the body for why the source cannot be. */
export async function renameVaultFile(
  fromRel: string,
  toRel: string,
): Promise<void> {
  const fromAbs = await resolveVaultPath(fromRel)
  const toAbs = await resolveVaultPath(toRel)
  const parent = await dirname(toAbs)
  await mkdir(parent, { recursive: true })
  // Move our belief along with the file: rename doesn't change content, so
  // whatever we knew `fromRel` to hold is what `toRel` now holds. Recorded
  // before the rename so it's in place when the OS delivers the create event.
  //
  // Only the DESTINATION can be recognised this way. The source's event is a
  // removal — there is nothing left at that path to compare — so it dispatches
  // and the watcher's move-correlation handles it. That was already true of the
  // hash filter this replaces, despite its comment claiming both were covered:
  // it also read the file at the path, which by then was gone.
  try {
    const bytes = await readFile(fromAbs)
    await noteDiskContent(toRel, bytes)
  } catch {
    // If we can't read the source, the rename will fail anyway.
  }
  knownDiskHashes.delete(fromRel)
  await rename(fromAbs, toAbs)
  // Schedule using the destination — that's what's visible in git
  // after the rename. The source removal is part of the same staged
  // change set (`git add -A`) so a single commit captures both.
  scheduleAutoCommit(toRel)
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

/** One recursive pass over the vault collecting BOTH inventories the
 * sidebar needs: every non-hidden subdirectory (`dirs`, so empty folders
 * still surface — the tree is otherwise built only from file paths) and
 * every non-markdown attachment file (`files`, the pdf/png/txt/… rows).
 * Notes (`.md`), dot-dirs/files, and app sidecars are excluded from
 * `files` by `isAttachmentFile`; `.`-prefixed dirs are skipped entirely
 * while `_`-prefixed ones are returned (the tree filters them). Single
 * traversal — both call sites (boot scan, watcher refresh) want both, so
 * walking the tree twice would double the readDir cost. */
export async function listVaultTreeRecursive(
  subRel = '',
): Promise<{ dirs: string[]; files: string[] }> {
  const empty = { dirs: [] as string[], files: [] as string[] }
  const root = getActiveVaultPath()
  if (!root) return empty
  if (subRel !== '' && !(await exists(await resolveVaultPath(subRel)))) return empty
  const absPath = subRel === '' ? root : await resolveVaultPath(subRel)
  let entries: Awaited<ReturnType<typeof readDir>>
  try {
    entries = await readDir(absPath)
  } catch {
    return empty
  }
  const dirs: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childRel = subRel === '' ? entry.name : `${subRel}/${entry.name}`
    if (entry.isDirectory) {
      dirs.push(childRel)
      const sub = await listVaultTreeRecursive(childRel)
      dirs.push(...sub.dirs)
      files.push(...sub.files)
    } else if (entry.isFile && isAttachmentFile(childRel)) {
      files.push(childRel)
    }
  }
  return { dirs, files }
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
    scheduleAutoCommit(relPath)
  }
}

/** Recursively delete a vault directory and everything inside it.
 * No-op if it doesn't exist. Used by one-time migrations that retire
 * a whole layout subtree (e.g. the old `daily/` folder). */
export async function deleteVaultDir(relPath: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  if (await exists(path)) {
    await remove(path, { recursive: true })
    scheduleAutoCommit(relPath)
  }
}

/** Create a folder (recursively) in the vault. Idempotent — succeeds
 * even if it already exists. Empty folders aren't tracked by git, but
 * they persist on disk and re-surface via listVaultTreeRecursive. */
export async function createVaultFolder(relPath: string): Promise<void> {
  const path = await resolveVaultPath(relPath)
  await mkdir(path, { recursive: true })
}

/** Send a vault file to the OS trash (macOS Trash / Windows Recycle Bin
 * / Linux trash) — the recoverable sibling of the permanent
 * {@link deleteVaultFile}. Routes through the native `move_to_trash`
 * command (the fs plugin only does permanent removes). No-op if the
 * file doesn't exist. */
export async function trashVaultFile(relPath: string): Promise<void> {
  if (!(await vaultFileExists(relPath))) return
  const path = await resolveVaultPath(relPath)
  await invoke('move_to_trash', { path })
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
    isDiskContentKnown,
  }
}
