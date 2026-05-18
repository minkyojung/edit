// Doc → vault file path mapping.
//
// In Phase 4 the vault on disk becomes the source of truth for every
// app doc (wiki entry, daily journal, system meta page). Each doc
// type has its own subdirectory + naming convention so a user
// browsing ~/Documents/Writer/ in Finder gets an immediately
// recognisable layout:
//
//   wiki/Tom.md                        ← entity page (wiki:custom-*)
//   wiki/Tom.marks.json                ← sidecar
//   daily/2026-05-17.md                ← daily journal (daily)
//   daily/2026-05-17/My note.md        ← writing note under a daily
//   _system/conventions.md             ← agent-managed meta (system:*)
//
// Writing notes live in a per-day subfolder so they group with their
// daily on disk. The subfolder only materialises when the day has at
// least one child — empty days stay as a single file. Multi-level
// nesting (writing under writing under daily) flattens on disk: every
// descendant of the same daily becomes its sibling under that day's
// folder. The tree structure stays in `knownDocs.parentId` (UI source
// of truth); disk stays flat so CLI listing remains useful.
//
// This module is the only place those mappings are defined. Vault
// helpers (vault.ts) take vault-relative strings and don't care how
// they were composed; this file is where docsStore + ingest + the
// file watcher meet to agree on file naming.
//
// Pure functions only — no I/O. Tests can pass synthetic KnownDoc
// shapes without standing up the rest of the app.

import type { KnownDoc } from '@/state/docsStore'

/** Lookup a doc by slug. Required by {@link pathForDoc} only for
 * `writing` docs (we need to walk parentId up to the daily ancestor
 * to pick the day folder). Other doc types ignore it. */
export type DocLookup = (slug: string) => KnownDoc | undefined

/** Vault-relative path of a doc's markdown body. Returns null when
 * the doc has no placement (a daily without a date, a writing whose
 * parent chain doesn't reach a daily). */
export function pathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  if (doc.type === 'daily') {
    if (!doc.date) return null
    return `daily/${doc.date}.md`
  }
  if (doc.type.startsWith('system:')) {
    const name = doc.type.slice('system:'.length)
    return `_system/${sanitizeFilename(name)}.md`
  }
  if (doc.type.startsWith('wiki:')) {
    const filename = sanitizeFilename(doc.title?.trim() || 'Untitled')
    return `wiki/${filename}.md`
  }
  if (doc.type === 'writing') {
    if (!getDoc) return null
    const dailyAncestor = findDailyAncestor(doc, getDoc)
    if (!dailyAncestor?.date) return null
    const filename = sanitizeFilename(doc.title?.trim() || 'Untitled')
    return `daily/${dailyAncestor.date}/${filename}.md`
  }
  return null
}

/** Vault-relative path of a doc's identity sidecar file. Same stem
 * as the markdown body, `.meta.json` suffix. Contains the doc's
 * persistent slug so scanVault can recover identity across restarts.
 *
 * Path C Stage 3: renamed from `.marks.json` to `.meta.json` since
 * the file no longer carries mark data — those moved into the `.ydoc`
 * binary. Returns null when {@link pathForDoc} returns null. */
export function metaPathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  const md = pathForDoc(doc, getDoc)
  if (!md) return null
  return md.replace(/\.md$/, '.meta.json')
}

/** Legacy `.marks.json` path — kept for the Stage 3 migration window
 * so scanVault can pick up slugs from existing sidecars and
 * flushDirty's rename-on-change can move old files along with their
 * new `.meta.json` counterpart. Stage 4 (full removal) will drop this. */
export function legacySidecarPathForDoc(
  doc: KnownDoc,
  getDoc?: DocLookup,
): string | null {
  const md = pathForDoc(doc, getDoc)
  if (!md) return null
  return md.replace(/\.md$/, '.marks.json')
}

/** Vault-relative path of a doc's Y.Doc binary sidecar. Same stem as
 * the markdown body, `.ydoc` suffix instead of `.md`. Stores the full
 * Yjs CRDT state — body fragment + marks Y.Map + RelativePositions —
 * so cross-restart mark anchoring survives without text-search
 * fragility. Returns null when {@link pathForDoc} returns null. */
export function ydocPathForDoc(doc: KnownDoc, getDoc?: DocLookup): string | null {
  const md = pathForDoc(doc, getDoc)
  if (!md) return null
  return md.replace(/\.md$/, '.ydoc')
}

/** Walk parentId up the chain until we hit a daily. Returns null if
 * the chain ends without one (orphan writing) or contains a cycle
 * (defensive — KnownDoc invariants forbid it, but we don't want a
 * pathological catalog to lock up the call site). */
function findDailyAncestor(doc: KnownDoc, getDoc: DocLookup): KnownDoc | null {
  const visited = new Set<string>()
  let current: KnownDoc | undefined = doc
  while (current && !visited.has(current.slug)) {
    visited.add(current.slug)
    if (current.type === 'daily') return current
    if (!current.parentId) return null
    current = getDoc(current.parentId)
  }
  return null
}

/** Strip filesystem-reserved characters from a filename component.
 * The set is the union of what Windows, macOS, and Linux refuse —
 * forward slash + backslash split into segments, the others are
 * forbidden on Windows in particular. Trims whitespace and falls
 * back to `'Untitled'` when nothing remains so callers never write
 * a file with an empty stem.
 *
 * Allowed: Unicode word characters (Hangul / CJK / Latin), spaces,
 * hyphens, underscores, dots inside the name. We do NOT lowercase
 * — Karpathy / Bear / Obsidian all keep title case (`Tom.md` not
 * `tom.md`) so the filename reads like the page name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
}
