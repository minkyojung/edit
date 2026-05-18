/**
 * docsStore — pure helpers.
 *
 * State-independent functions used by multiple slices (date math,
 * doc policy table). Extracting them here lets sibling slice files
 * import them freely without dragging in the store's `set/get`
 * surface, and keeps the slice files focused on store wiring.
 *
 * Two families live here:
 *
 *   1. Date helpers (monthAnchorOf, shiftDayAnchor, shiftMonthAnchor,
 *      weekStartFor) — local-time arithmetic on YYYY-MM / YYYY-MM-DD
 *      strings. Used by dateNavSlice (anchors), sidebar Week grouping,
 *      and bootstrap (initial monthAnchor).
 *
 *   2. Doc policy table (DAILY/WRITING/WIKI_CONTENT/SYSTEM_META_POLICY
 *      + getDocPolicy + isWikiDoc + isUserOwnedWiki) — the capability
 *      matrix every "can this doc be archived/moved/ingested" check
 *      reads from. Adding a new doc category means adding one row
 *      here, not chasing scattered `type.startsWith(...)` checks.
 *
 * All exports are pure functions / immutable constants — no zustand
 * involvement, no async. Safe to import from anywhere.
 */

import { formatLocalDate, todayLocalDate } from '@/hooks/useDocMeta'
import { pathForDoc } from '@/lib/docPaths'
import type { DocPolicy, DocsState, KnownDoc } from './types'

// ── Doc policy table ───────────────────────────────────────────────

const DAILY_POLICY: DocPolicy = {
  category: 'daily',
  sidebarGroup: 'date',
  canArchive: false,
  canBeMovedInWikiTree: false,
  isIngestSource: true,
  isAgentManaged: false,
}
const WRITING_POLICY: DocPolicy = {
  category: 'writing',
  sidebarGroup: 'date', // shown nested under its parent daily
  canArchive: true,
  canBeMovedInWikiTree: false,
  isIngestSource: true,
  isAgentManaged: false,
}
const WIKI_CONTENT_POLICY: DocPolicy = {
  category: 'wiki-content',
  sidebarGroup: 'wiki',
  canArchive: true,
  canBeMovedInWikiTree: true,
  isIngestSource: false,
  isAgentManaged: true,
}
const SYSTEM_META_POLICY: DocPolicy = {
  category: 'system-meta',
  sidebarGroup: 'system',
  canArchive: false,
  canBeMovedInWikiTree: false,
  isIngestSource: false,
  isAgentManaged: true,
}

/** Resolve a doc's policy by type. Unknown / legacy types fall
 * through to wiki-content — the v6 migration already moved the
 * pre-rename `wiki:conventions|log|index` to `system:*`, so any
 * leftover `wiki:*` here is genuinely user content (or corrupt
 * data we shouldn't crash on). */
export function getDocPolicy(doc: Pick<KnownDoc, 'type'>): DocPolicy {
  if (doc.type === 'daily') return DAILY_POLICY
  if (doc.type === 'writing') return WRITING_POLICY
  if (doc.type.startsWith('system:')) return SYSTEM_META_POLICY
  if (doc.type.startsWith('wiki:')) return WIKI_CONTENT_POLICY
  return WIKI_CONTENT_POLICY
}

/** True for any wiki-region page: agent-managed (`system:*` meta
 * and `wiki:custom-*` content). Now a thin wrapper over the
 * policy table so the source of truth is one struct, not two
 * helpers. Kept for callsite readability ("is this in the wiki
 * sidebar region?"). */
export function isWikiDoc(doc: Pick<KnownDoc, 'type'>): boolean {
  return getDocPolicy(doc).isAgentManaged
}

/** Karpathy write-ownership invariant: whoever wrote the page may
 * delete it. Thin wrapper around the policy table — `canArchive`
 * is true exactly for the category the user can wipe. */
export function isUserOwnedWiki(doc: Pick<KnownDoc, 'type'>): boolean {
  return getDocPolicy(doc).category === 'wiki-content'
}

// ── Vault path lookup ──────────────────────────────────────────────

/** Reverse-lookup a doc's slug from a vault-relative `.md` path.
 *
 * The watcher receives paths like `daily/2026-05-18.md` or
 * `wiki/Tom.md`; reload / remove handlers need to find the matching
 * doc to address its handle. We compute each known doc's vault path
 * via {@link pathForDoc} and compare. Linear scan is fine — knownDocs
 * sizes (hundreds, low thousands) make this a sub-ms loop and the
 * watcher fires at most a few times per second.
 *
 * Returns null when the path corresponds to a doc the catalog doesn't
 * know about (typical for the `add` flow — caller should mint a new
 * KnownDoc instead). Archived docs are excluded from the search so a
 * still-on-disk file under `wiki/` doesn't shadow a live wiki page
 * with the same title.
 */
export function findSlugByVaultPath(
  knownDocs: KnownDoc[],
  rel: string,
): string | null {
  const bySlug = new Map(knownDocs.map((d) => [d.slug, d]))
  const getDoc = (slug: string) => bySlug.get(slug)
  for (const doc of knownDocs) {
    if (doc.archivedAt) continue
    if (pathForDoc(doc, getDoc) === rel) return doc.slug
  }
  return null
}

// ── Date arithmetic ────────────────────────────────────────────────

/** Extract the YYYY-MM anchor from a YYYY-MM-DD date string. */
export function monthAnchorOf(date: string): string {
  return date.slice(0, 7)
}

/** Step a YYYY-MM-DD date by `delta` days (negative for past). Mirrors
 * shiftMonthAnchor — UTC-free local-time arithmetic so day boundaries
 * follow the user's wall clock. */
export function shiftDayAnchor(date: string, delta: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + delta)
  return formatLocalDate(d)
}

/** Step a YYYY-MM anchor by `delta` months (negative for past). */
export function shiftMonthAnchor(anchor: string, delta: number): string {
  const [yStr, mStr] = anchor.split('-')
  const y = Number(yStr)
  const m = Number(mStr) // 1-12
  // JS Date math: month is 0-indexed and auto-rolls year boundaries.
  const d = new Date(y, m - 1 + delta, 1)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

// ── Tab-strip invariant ────────────────────────────────────────────

/** Apply the "tab strip is never empty" invariant to a state patch
 * about to be passed to set(). If the patch (or current state, if
 * the patch doesn't touch openSlugs) would leave openSlugs empty,
 * today's daily slug is folded back in synchronously and made active
 * — so the user never sees a blank tab strip, regardless of whether
 * any follow-up async work succeeds or fails.
 *
 * The invariant lives here rather than scattered across each
 * mutation (closeDoc / archiveDoc / deleteForever / emptyArchive)
 * because the policy is identical at every site: "if removing this
 * slug would empty the strip, fall back to today's daily."
 *
 * No-op when today's daily isn't in the catalog (bootstrap hasn't
 * run yet, or the day rolled over since bootstrap). In that edge
 * case the strip stays empty for the moment — caller's own async
 * follow-up (ensureHandle, openDaily) is the next line of defense,
 * but it's not relied on for the common path. */
export function ensureNonEmptyTabStrip(
  state: DocsState,
  patch: Partial<DocsState>,
): Partial<DocsState> {
  const nextOpen = patch.openSlugs ?? state.openSlugs
  if (nextOpen.length > 0) return patch
  const today = todayLocalDate()
  const todayDaily = state.knownDocs.find(
    (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
  )
  if (!todayDaily) return patch
  return {
    ...patch,
    openSlugs: [todayDaily.slug],
    activeSlug: todayDaily.slug,
  }
}

// ── Date helpers ───────────────────────────────────────────────────

/** Compute the Monday-anchored start of the calendar week
 * containing `date` (YYYY-MM-DD). ISO-week convention. */
export function weekStartFor(date: string): string {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun … 6=Sat
  // Distance back to Monday: Sun→6, Mon→0, Tue→1, … Sat→5.
  const back = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - back)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
