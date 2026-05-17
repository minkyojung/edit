// Doc → vault file path mapping.
//
// In Phase 4 the vault on disk becomes the source of truth for every
// app doc (wiki entry, daily journal, system meta page). Each doc
// type has its own subdirectory + naming convention so a user
// browsing ~/Documents/Writer/ in Finder gets an immediately
// recognisable layout:
//
//   wiki/Tom.md              ← entity page (wiki:custom-*)
//   wiki/Tom.marks.json      ← sidecar
//   daily/2026-05-17.md      ← daily journal (daily)
//   _system/conventions.md   ← agent-managed meta (system:conventions)
//
// This module is the only place those mappings are defined. Vault
// helpers (vault.ts) take vault-relative strings and don't care how
// they were composed; this file is where docsStore + ingest + the
// file watcher meet to agree on file naming.
//
// Pure functions only — no I/O. Tests can pass synthetic KnownDoc
// shapes without standing up the rest of the app.

import type { KnownDoc } from '@/state/docsStore'

/** Vault-relative path of a doc's markdown body. Returns null for
 * doc types we don't know how to place on disk yet (currently
 * `writing` — handled in a future sub-phase if we keep that type). */
export function pathForDoc(doc: KnownDoc): string | null {
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
  return null
}

/** Vault-relative path of a doc's sidecar marks file. Same stem as
 * the markdown body, `.marks.json` suffix instead of `.md`. Returns
 * null when {@link pathForDoc} returns null. */
export function sidecarPathForDoc(doc: KnownDoc): string | null {
  const md = pathForDoc(doc)
  if (!md) return null
  return md.replace(/\.md$/, '.marks.json')
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
