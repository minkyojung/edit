// Vault index — the app-private catalog that lives OUTSIDE the user's
// notes, at `.octave/index.json` (the vault's dot-folder, mirroring how
// Obsidian keeps its state in `.obsidian/`).
//
// Why it exists:
//   The vault's `.md` files are the source of truth for CONTENT — body,
//   plus portable frontmatter a user or another tool understands
//   (`created`, `tags`, `aliases`, `source`). But octave also needs a
//   little private bookkeeping that is NOT the user's and that other
//   tools can't interpret:
//     - `slug` — octave's stable surrogate key for a note. Identity the
//       user sees is the file's PATH; internally octave keys hundreds of
//       call sites (open tab, which thread belongs to which doc, …) off a
//       slug BECAUSE paths mutate on rename/move and a stable key must
//       not. Keeping the slug here (not in the `.md`) is the surrogate-key
//       pattern done right: the natural key (path) stays in the
//       filesystem, the surrogate key stays in the app's own store.
//     - soft state — archive flags and AI-derived summary/importance that
//       must survive the boot rebuild but don't belong in the user's file.
//
// Durability contract:
//   `.octave/` is app state, NOT a throwaway cache. Deleting it re-mints
//   slugs (breaking thread↔doc links) and drops archive state. Treat it
//   like `.obsidian/`: sync it, back it up, don't casually remove it. The
//   CONTENT of every note survives regardless — that's the file-first
//   guarantee — but this bookkeeping does not reconstruct from content.
//
// This module is the pure read/write/mutate layer. Wiring it into the
// scan / flush / watcher pipelines lands in later steps; nothing imports
// it yet, so adding it changes no existing behaviour.

import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'

/** `.octave/index.json`, vault-relative. The dot-folder keeps the file
 * out of the sidebar (the watcher ignores dot-dir segments) and out of
 * any other markdown tool's way. */
export const VAULT_INDEX_REL = '.octave/index.json'

/** One note's app-private record, keyed in {@link VaultIndex.entries} by
 * the note's vault-relative `.md` path. Every field except `slug` is
 * soft state that layers onto the path-derived catalog entry; absent
 * fields simply don't apply to that note. */
export interface VaultIndexEntry {
  /** Stable surrogate key for the note. Minted once, never derived from
   * the (mutable) path, so it survives rename/move. */
  slug: string
  /** Soft-delete timestamp (epoch ms). Present ⇒ archived. */
  archivedAt?: number
  /** Pre-archive parent slug, so unarchive can restore tree structure. */
  archivedFromParent?: string
  /** One-line LLM summary feeding the wiki index. Recomputable, but cached
   * here so boot doesn't re-summarise every page. */
  aiSummary?: string
  /** 0–100 ranking score for hot-context selection. Recomputable. */
  aiImportance?: number
}

/** The whole on-disk index. `version` is the migration lever — a future
 * shape change reads old files as `version: 1` and upgrades on write. */
export interface VaultIndex {
  version: 1
  /** path → record. Path is the note's vault-relative `.md` location. */
  entries: Record<string, VaultIndexEntry>
}

/** A fresh, empty index. Also the fallback whenever the file is missing
 * or unreadable — a lost index degrades to "every note looks new" rather
 * than crashing boot. */
export function emptyVaultIndex(): VaultIndex {
  return { version: 1, entries: {} }
}

// ── Pure core (parse / serialize / mutate) ────────────────────────────
// Split out from the I/O wrappers so the interesting logic is testable
// without a vault on disk.

/**
 * Parse the on-disk JSON into a {@link VaultIndex}. Never throws: a
 * missing/corrupt/foreign-shaped payload yields an empty index, so a
 * damaged file behaves like a fresh vault instead of stranding boot.
 * Entries missing a string `slug` are dropped (a record with no surrogate
 * key is meaningless).
 */
export function parseVaultIndex(raw: string): VaultIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyVaultIndex()
  }
  if (!parsed || typeof parsed !== 'object') return emptyVaultIndex()
  const rawEntries = (parsed as { entries?: unknown }).entries
  if (!rawEntries || typeof rawEntries !== 'object') return emptyVaultIndex()

  const entries: Record<string, VaultIndexEntry> = {}
  for (const [path, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const slug = (value as { slug?: unknown }).slug
    if (typeof slug !== 'string' || slug.length === 0) continue
    const entry: VaultIndexEntry = { slug }
    const v = value as Record<string, unknown>
    if (typeof v.archivedAt === 'number') entry.archivedAt = v.archivedAt
    if (typeof v.archivedFromParent === 'string')
      entry.archivedFromParent = v.archivedFromParent
    if (typeof v.aiSummary === 'string') entry.aiSummary = v.aiSummary
    if (typeof v.aiImportance === 'number') entry.aiImportance = v.aiImportance
    entries[path] = entry
  }
  return { version: 1, entries }
}

/** Serialize to the exact on-disk form (pretty JSON + trailing newline,
 * matching the other JSON sidecars the app writes). */
export function serializeVaultIndex(index: VaultIndex): string {
  return JSON.stringify(index, null, 2) + '\n'
}

/** Return the record at `path`, or undefined. */
export function getEntry(
  index: VaultIndex,
  path: string,
): VaultIndexEntry | undefined {
  return index.entries[path]
}

/** Immutably upsert the record at `path`. Returns a new index; the input
 * is left untouched so callers can diff or discard. */
export function setEntry(
  index: VaultIndex,
  path: string,
  entry: VaultIndexEntry,
): VaultIndex {
  return { ...index, entries: { ...index.entries, [path]: entry } }
}

/** Immutably drop the record at `path` (no-op if absent). */
export function removeEntry(index: VaultIndex, path: string): VaultIndex {
  if (!(path in index.entries)) return index
  const entries = { ...index.entries }
  delete entries[path]
  return { ...index, entries }
}

/**
 * Move a record from `fromPath` to `toPath`, preserving its slug + soft
 * state. This is the rename/move re-key: the note is the same note (same
 * surrogate key), only its natural key (path) changed. No-op when
 * `fromPath` has no record. If `toPath` already holds a record it is
 * overwritten — a move onto an existing path means that path's file was
 * replaced, so the incoming record wins.
 */
export function rekeyEntry(
  index: VaultIndex,
  fromPath: string,
  toPath: string,
): VaultIndex {
  if (fromPath === toPath) return index
  const entry = index.entries[fromPath]
  if (!entry) return index
  const entries = { ...index.entries }
  delete entries[fromPath]
  entries[toPath] = entry
  return { ...index, entries }
}

// ── I/O wrappers ──────────────────────────────────────────────────────
// Thin: read → parse, serialize → write. The pure core above is where the
// behaviour lives.

/** Read + parse `.octave/index.json`. Returns an empty index when the
 * file doesn't exist yet or can't be read (fresh vault, first run). */
export async function readVaultIndex(): Promise<VaultIndex> {
  try {
    if (!(await vaultFileExists(VAULT_INDEX_REL))) return emptyVaultIndex()
    return parseVaultIndex(await readVaultFile(VAULT_INDEX_REL))
  } catch (err) {
    console.warn('[vaultIndex] read failed — using empty index', err)
    return emptyVaultIndex()
  }
}

/** Serialize + write `.octave/index.json`. `writeVaultFile` creates the
 * `.octave/` folder on demand (recursive mkdir). */
export async function writeVaultIndex(index: VaultIndex): Promise<void> {
  await writeVaultFile(VAULT_INDEX_REL, serializeVaultIndex(index))
}
