// Vault I/O for chat threads.
//
// Each thread occupies a pair of files in `.octave/threads/` (the app's
// hidden internal namespace — see lib/octave.ts):
//
//   <id>.json         — ThreadMeta. Atomic rewrite on every
//                                metadata change (title, archived,
//                                model, ...). Small; cost is irrelevant.
//   <id>.turns.jsonl  — ChatTurn per line, append-only. Long
//                                threads stay cheap because we never
//                                rewrite the whole file.
//
// The pair pattern mirrors the doc files (.md + .meta.json + .ydoc):
// one file holds the source-of-truth payload, sidecars hold metadata.
// Here the turns file is the bulk payload and the JSON is the
// sidecar, just inverted from the doc case where the .md is the
// bulk and .ydoc / .meta are the sidecars.
//
// Out of scope:
//   - in-memory caching / observers   — state/threadsStore.ts
//   - hook surface for React          — hooks/useThreads(.ts|TurnTurns)
//   - reacting to external edits      — file watcher (already wired
//                                       at the vault level; thread
//                                       conflict handling can layer
//                                       on top later)

import type { ChatTurn, ThreadMeta } from '@/chat/types'
import {
  appendVaultFile,
  deleteVaultFile,
  listVaultDir,
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'

import { OCTAVE_THREADS_DIR as THREADS_DIR } from '@/lib/octave'

function metaPath(id: string): string {
  return `${THREADS_DIR}/${id}.json`
}

function turnsPath(id: string): string {
  return `${THREADS_DIR}/${id}.turns.jsonl`
}

// Per-thread-id serialisation. appendVaultFile is read-modify-write (not an
// OS-level append), so two concurrent writes to the same thread's turns file
// each read the same old bytes and the later write clobbers the earlier —
// silently dropping a turn. This clobber is invisible in memory (the store's
// optimistic set keeps both) and only surfaces after a reload. Every mutation
// of a thread's files runs through this queue so append / batch-append /
// rewrite / delete on one id can't overlap. Keyed by thread id (not path) so
// deleteThreadFiles — which touches both `.json` and `.jsonl` — serialises
// against in-flight turn writes too.
const chains = new Map<string, Promise<unknown>>()

/** Run `fn` after any prior operation on the same thread id has settled.
 * Enqueues synchronously, so call order == disk order == the store's
 * optimistic in-memory order. A failed op doesn't block the next one. */
function runExclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(id, next)
  // Drop the entry once it's the tail and settled, so the map doesn't grow
  // unbounded over a long session.
  void next.finally(() => {
    if (chains.get(id) === next) chains.delete(id)
  })
  return next as Promise<T>
}

/** Read a single thread's metadata. Returns null when the file is
 * absent (thread never created or already deleted) or unparseable
 * (corrupt JSON — we'd rather skip than throw and break the boot
 * scan; the affected thread surfaces as "missing" instead of crashing
 * the whole sidebar). */
export async function readThreadMeta(id: string): Promise<ThreadMeta | null> {
  const path = metaPath(id)
  if (!(await vaultFileExists(path))) return null
  try {
    const raw = await readVaultFile(path)
    return JSON.parse(raw) as ThreadMeta
  } catch (err) {
    console.warn('[threadFiles] meta parse failed', { id, err })
    return null
  }
}

/** Atomically write a thread's metadata. Used for every meta-only
 * mutation: rename, archive, model/effort switch, sessionStarted
 * flip. Body of the JSON is the same `ThreadMeta` shape the rest of
 * the app sees, so we round-trip without a separate file shape. */
export function writeThreadMeta(meta: ThreadMeta): Promise<void> {
  // Same per-id queue as the turn writes. The meta file is a full rewrite over
  // a shared `<path>.tmp`, so two concurrent writes (title vs archive vs the
  // agent's contextUsage, all fire-and-forget) would corrupt it or land an
  // older snapshot last. Serialising per thread id makes each write a clean,
  // ordered full-snapshot — last write wins with the newest state.
  return runExclusive(meta.id, async () => {
    const path = metaPath(meta.id)
    await writeVaultFile(path, JSON.stringify(meta, null, 2) + '\n')
  })
}

/** Read every turn of a thread, in order. Each line is one ChatTurn
 * serialised as JSON. Blank lines (a tail newline, for instance) are
 * skipped. A line that fails to parse is logged and skipped — losing
 * one turn beats losing the whole transcript when a single record is
 * corrupt. Returns [] when the file doesn't exist (new thread, no
 * turns yet). */
export async function readThreadTurns(id: string): Promise<ChatTurn[]> {
  const path = turnsPath(id)
  if (!(await vaultFileExists(path))) return []
  const raw = await readVaultFile(path)
  const out: ChatTurn[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line) as ChatTurn)
    } catch (err) {
      console.warn('[threadFiles] turn parse failed; skipping line', { id, err })
    }
  }
  return out
}

/** Append a single turn to a thread. Serialised as one line + LF so
 * the file stays parseable line-by-line. The newline goes at the end
 * (not the start) so a crash between writes leaves a clean line
 * boundary rather than a leading orphan newline that confuses
 * readers. */
export function appendThreadTurn(id: string, turn: ChatTurn): Promise<void> {
  return runExclusive(id, async () => {
    const path = turnsPath(id)
    // Inline JSON — no indentation — so each line is exactly one record.
    // A turn carrying a multi-line string (markdown / code) round-trips
    // through JSON.stringify's escape, so the on-disk line never wraps.
    await appendVaultFile(path, JSON.stringify(turn) + '\n')
  })
}

/** Append several turns as ONE write. appendVaultFile is read-modify-write
 * (not an OS-level append), so two back-to-back appendThreadTurn calls race
 * and lose an update; callers that must land multiple turns in a fixed order
 * (e.g. the AskUserQuestion turn-split: committed turn + answer bubble) use
 * this to write them atomically and in order. */
export function appendThreadTurns(id: string, turns: ChatTurn[]): Promise<void> {
  if (turns.length === 0) return Promise.resolve()
  return runExclusive(id, async () => {
    const path = turnsPath(id)
    await appendVaultFile(path, turns.map((t) => JSON.stringify(t) + '\n').join(''))
  })
}

/** Rewrite a thread's turn file from a fresh array. Required by
 * removeTurn (Regenerate's "drop the last assistant turn") because
 * JSONL append-only can't selectively delete a record.
 *
 * Trade-off: this is O(n) in the number of turns. Acceptable because
 * remove is rare (only Regenerate triggers it) compared to append
 * (every assistant settle). Atomic — same tmp+rename as
 * {@link writeThreadMeta} — so a crash mid-rewrite can't truncate
 * the existing turns. */
export function rewriteThreadTurns(
  id: string,
  turns: ChatTurn[],
): Promise<void> {
  return runExclusive(id, async () => {
    const path = turnsPath(id)
    const body = turns.map((t) => JSON.stringify(t)).join('\n')
    // Trailing newline so a future append lands on its own line.
    await writeVaultFile(path, turns.length === 0 ? '' : body + '\n')
  })
}

/** Discover every thread id stored in the vault. Used at boot to
 * populate the in-memory store from disk. Returns ids without the
 * file extension; pairs missing the .json sidecar (turns file
 * orphaned) are surfaced as warnings and skipped. */
export async function listThreadIds(): Promise<string[]> {
  if (!(await vaultFileExists(THREADS_DIR))) return []
  let entries: string[]
  try {
    entries = await listVaultDir(THREADS_DIR)
  } catch (err) {
    console.warn('[threadFiles] list failed', err)
    return []
  }
  const ids: string[] = []
  for (const name of entries) {
    // `<id>.json` is the canonical marker. `<id>.turns.jsonl` without
    // a matching meta is meaningless on its own — we skip it rather
    // than synthesise a placeholder meta the user never opted into.
    if (!name.endsWith('.json') || name.endsWith('.turns.jsonl')) continue
    const id = name.slice(0, -'.json'.length)
    if (id.length > 0) ids.push(id)
  }
  return ids
}

/** Remove a thread's meta + turns from disk. Used by hard-delete
 * paths (cleanup of orphaned threads when the parent doc is
 * permanently removed). No-op on missing files. */
export function deleteThreadFiles(id: string): Promise<void> {
  return runExclusive(id, async () => {
    await deleteVaultFile(metaPath(id))
    await deleteVaultFile(turnsPath(id))
  })
}
