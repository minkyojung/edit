/**
 * lastView — session-restore of the last-viewed doc, keyed by PATH.
 *
 * The slug is an ephemeral per-boot handle, so we can't persist "which doc
 * was open" by slug — it'd be stale next launch. Instead we persist the
 * doc's vault-relative PATH plus the view shape (day/week/month + anchor),
 * and `bootstrap` resolves the path back to this boot's fresh slug and
 * rebuilds the URL.
 *
 * Kept as a standalone module (not inside usePersistLastPath) so both the
 * writer hook and the docsStore bootstrap can import it without a cycle —
 * this file depends only on windowRoot + viewUrl types.
 */

import { projectStorageKey } from '@/lib/windowRoot'
import type { SidebarTab } from '@/lib/viewUrl'

/** Per-project so two vault windows don't restore each other's last doc. */
export const LAST_VIEW_STORAGE_KEY = 'writer-tauri:lastView'

export interface LastViewRecord {
  /** Vault-relative path of the last-viewed doc — the stable identity. */
  path: string
  /** The sidebar view shape to restore alongside the doc. */
  tab: SidebarTab
  dayAnchor: string
  monthAnchor: string
}

export function writeLastView(record: LastViewRecord): void {
  try {
    localStorage.setItem(projectStorageKey(LAST_VIEW_STORAGE_KEY), JSON.stringify(record))
  } catch {
    // Session restore is a nice-to-have, not correctness — swallow quota /
    // private-mode write errors.
  }
}

export function readLastView(): LastViewRecord | null {
  try {
    const raw = localStorage.getItem(projectStorageKey(LAST_VIEW_STORAGE_KEY))
    if (!raw) return null
    const r = JSON.parse(raw) as Partial<LastViewRecord>
    if (r && typeof r.path === 'string' && typeof r.tab === 'string') {
      return {
        path: r.path,
        tab: r.tab,
        dayAnchor: typeof r.dayAnchor === 'string' ? r.dayAnchor : '',
        monthAnchor: typeof r.monthAnchor === 'string' ? r.monthAnchor : '',
      }
    }
  } catch {
    // Corrupt / legacy (pre-path) value — treat as no saved view.
  }
  return null
}
