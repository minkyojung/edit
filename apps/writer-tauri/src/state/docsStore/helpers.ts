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

import { formatLocalDate } from '@/hooks/useDocMeta'
import type { DocPolicy, KnownDoc } from './types'

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
