// Unified pending-changes store — the single queue every AI surface
// (chat Edit/Write, ingest proposal) pushes into. UI reads from this
// store only: sidebar dot (Phase B), in-page inline review (Phase C),
// activity overview in the Review Panel (Phase D).
//
// Model: **staged preview**.
//   AI emits an edit intent → host translates into a `PendingChange`
//   and pushes here. The disk is NOT touched yet. PM renders the
//   change inline (added text shown with green tint, removed text
//   strikethrough). The user clicks Accept on the change to commit
//   it to disk, or Reject to drop it.
//
// This matches the convention every reviewed-AI editor (Cursor,
// Continue, Zed inline assistant, Notion AI Suggestion, Google Docs
// Suggesting) follows. Cursor briefly tried "auto-apply + post-hoc
// review" in 2025 and faced enough user pushback to revert; we skip
// that detour.
//
// Why a single store:
//   The two AI surfaces (chat tool calls, ingest proposals) used to
//   live in separate stores with separate UIs (`pendingEditsStore`,
//   `useIngestStore.pendingProposals`, plus a separate Review Panel
//   for git activity). Users had to learn three patterns for the
//   same underlying action — "AI proposes a change → I decide".
//   Folding them into one queue gives one mental model and one set
//   of UI affordances.
//
// What this store does NOT do:
//   - It does NOT write to disk. Acceptance is signalled here; the
//     host's apply path (PM dispatch + flushDirty for chat; ingest's
//     materialise + appendMarkdownToWikiPage for ingest) reads the
//     accepted change and performs the disk write.
//   - It does NOT track AI activity history. That lives in the
//     gitStore (ai-edit commits). The Review Panel (Phase D) joins
//     this store's "currently pending" + gitStore's "past activity"
//     for a complete picture.
//   - It does NOT own the visual layer. PM decorations + sidebar dot
//     are separate concerns that subscribe to this store.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** A single line-level edit inside a PendingChange. One PendingChange
 * may carry several `edits` when a single intent (e.g. one ingest
 * proposal) lands multiple bullets at once. */
export interface PendingEdit {
  /** Stable id within the parent PendingChange. Used by PM decorations
   * to key widget DOM nodes so React-style reconciliation stays cheap
   * across re-renders. */
  id: string
  /** What this edit does to the page body:
   *   - 'add'     — insert new text at `anchorAfter`
   *   - 'replace' — swap `before` text with `after` text
   *   - 'delete'  — remove `before` text
   * Ingest proposals are always 'add' (always append). Chat Edit
   * tool calls map to 'replace'; chat Write to 'add' on a brand-new
   * file. */
  kind: 'add' | 'replace' | 'delete'
  /** Content-based anchor — the literal text immediately before the
   * insertion / replacement point. Survives PM transaction maps
   * better than absolute positions and survives external edits to
   * unrelated parts of the file. Empty string = beginning of doc. */
  anchorBefore: string
  /** Optional second anchor — for `replace` / `delete`, the literal
   * text that will be removed. For `add`, omitted (use anchorBefore
   * alone). */
  before?: string
  /** New text to insert. Required for `add` / `replace`. */
  after?: string
}

/** One pending change waiting for the user's decision. Either source
 * — chat tool call or ingest proposal — produces this shape. */
export interface PendingChange {
  id: string
  /** Which AI surface emitted this. Lets the UI render slightly
   * different chrome (e.g. ingest changes show the source daily;
   * chat changes show the thread id). */
  source: 'chat' | 'ingest'
  /** Slug of the doc whose body this change targets. The sidebar
   * dot indicator (Phase B) groups by this; the inline review
   * plugin (Phase C) renders only changes whose slug matches the
   * currently-mounted editor. */
  pageSlug: string
  /** Group identifier for batch reject. All changes from the same
   * ingest pass share one `groupId`; chat tool calls within one
   * agent run share theirs. Lets the user reject "everything from
   * that ingest" in one click without per-change interaction. */
  groupId: string
  /** ms since epoch when the change was queued. */
  createdAt: number
  /** Line-level edits this change carries. Most ingest proposals
   * produce one or two; chat Edit calls produce one; chat Write
   * produces one against an empty target. */
  edits: PendingEdit[]
  /** Provenance + reasoning, surfaced in the inline review chip and
   * in the Review Panel timeline. */
  context: {
    /** Chat: the thread that originated this change. */
    threadId?: string
    /** Ingest: the daily / source note this was derived from. */
    sourceSlug?: string
    /** Ingest: short rationale the LLM emitted ("user career
     * change") — surfaced as the chip's secondary line. */
    rationale?: string
    /** Ingest: the exact source sentence the LLM cited. */
    sourceQuote?: string
  }
  /** Where the change is in its lifecycle. `pending` is the only
   * state the inline review UI acts on. `accepted` / `rejected`
   * stay in the store for a short window so the Review Panel
   * timeline can show "you accepted X at HH:MM" — the cleanup
   * sweep below evicts them after a few minutes. */
  status: 'pending' | 'accepted' | 'rejected'
  /** ms since epoch when `status` flipped away from `pending`. Null
   * while still pending. */
  decidedAt: number | null
}

interface PendingChangesState {
  /** All changes (pending + recently-decided) keyed by id. */
  byId: Record<string, PendingChange>

  /** Push a new staged change. Called by the chat run's tool-gate
   * handler and the ingest pipeline. `id` is caller-minted so the
   * caller can correlate later (chat: pendingId from sidecar;
   * ingest: a fresh UUID). Idempotent on the id — re-push with the
   * same id is treated as a content refresh, preserving status only
   * if it's still `pending`. */
  push: (change: Omit<PendingChange, 'status' | 'decidedAt' | 'createdAt'> & {
    createdAt?: number
  }) => void

  /** User clicked Accept on one change. Flips status; the host's
   * apply path (a subscriber to this store) reads the accepted
   * change and writes to disk. No-op if the change is already
   * decided. */
  accept: (id: string) => void

  /** User clicked Reject on one change. Same lifecycle as accept,
   * but the apply path skips the disk write. */
  reject: (id: string) => void

  /** Reject every still-pending change in a group. Used by the
   * page-level "AI made this page — reject everything" affordance
   * (Phase C banner) and by the Review Panel's bulk action. */
  rejectGroup: (groupId: string) => void

  /** Drop changes whose `pageSlug` doesn't match any live doc
   * anymore (page deleted / archived). Idempotent. Called by the
   * docsStore on removeKnownDoc + archiveDoc. */
  pruneOrphaned: (validSlugs: ReadonlySet<string>) => void

  /** Forget changes that finished long ago. The store keeps the
   * `accepted` / `rejected` records briefly so the Review Panel
   * can show "just accepted" rows; this evicts the ones past the
   * window. Idempotent. */
  pruneDecided: (olderThanMs?: number) => void

  // ── Selectors ───────────────────────────────────────────────

  /** All still-pending changes for a given page, oldest first.
   * Sidebar dot uses `.length > 0` only; the inline review plugin
   * iterates the list. */
  pendingForPage: (pageSlug: string) => PendingChange[]

  /** All slugs with at least one pending change — the set the
   * sidebar dot indicator subscribes to. Recomputed cheaply (the
   * set rarely exceeds a few dozen entries). */
  pagesWithPending: () => Set<string>
}

/** How long an accepted / rejected change stays in the store before
 * `pruneDecided` drops it. Long enough that the Review Panel still
 * sees "just now" entries when the user opens it after a Sync; short
 * enough that the store doesn't grow unbounded over a long session. */
const DECIDED_RETENTION_MS = 10 * 60 * 1000  // 10 minutes

export const usePendingChangesStore = create<PendingChangesState>()(
  persist(
    (set, get) => ({
      byId: {},

      push: (change) => {
        set((s) => {
          const existing = s.byId[change.id]
          // Re-push of an already-decided change is ignored — the
          // user's decision sticks. Only `pending` (or first-time
          // push) refreshes the content.
          if (existing && existing.status !== 'pending') return s
          const next: PendingChange = {
            id: change.id,
            source: change.source,
            pageSlug: change.pageSlug,
            groupId: change.groupId,
            createdAt: change.createdAt ?? Date.now(),
            edits: change.edits,
            context: change.context,
            status: 'pending',
            decidedAt: null,
          }
          return { byId: { ...s.byId, [change.id]: next } }
        })
      },

      accept: (id) => {
        set((s) => {
          const existing = s.byId[id]
          if (!existing || existing.status !== 'pending') return s
          return {
            byId: {
              ...s.byId,
              [id]: { ...existing, status: 'accepted', decidedAt: Date.now() },
            },
          }
        })
      },

      reject: (id) => {
        set((s) => {
          const existing = s.byId[id]
          if (!existing || existing.status !== 'pending') return s
          return {
            byId: {
              ...s.byId,
              [id]: { ...existing, status: 'rejected', decidedAt: Date.now() },
            },
          }
        })
      },

      rejectGroup: (groupId) => {
        set((s) => {
          const next: Record<string, PendingChange> = {}
          const now = Date.now()
          let changed = false
          for (const [id, c] of Object.entries(s.byId)) {
            if (c.groupId === groupId && c.status === 'pending') {
              next[id] = { ...c, status: 'rejected', decidedAt: now }
              changed = true
            } else {
              next[id] = c
            }
          }
          return changed ? { byId: next } : s
        })
      },

      pruneOrphaned: (validSlugs) => {
        set((s) => {
          const next: Record<string, PendingChange> = {}
          let dropped = 0
          for (const [id, c] of Object.entries(s.byId)) {
            if (!validSlugs.has(c.pageSlug)) {
              dropped += 1
              continue
            }
            next[id] = c
          }
          if (dropped === 0) return s
          console.log(`[pendingChanges] pruned ${dropped} orphaned`)
          return { byId: next }
        })
      },

      pruneDecided: (olderThanMs = DECIDED_RETENTION_MS) => {
        set((s) => {
          const cutoff = Date.now() - olderThanMs
          const next: Record<string, PendingChange> = {}
          let dropped = 0
          for (const [id, c] of Object.entries(s.byId)) {
            if (
              c.status !== 'pending' &&
              c.decidedAt !== null &&
              c.decidedAt < cutoff
            ) {
              dropped += 1
              continue
            }
            next[id] = c
          }
          return dropped === 0 ? s : { byId: next }
        })
      },

      pendingForPage: (pageSlug) => {
        const all = Object.values(get().byId)
        return all
          .filter((c) => c.status === 'pending' && c.pageSlug === pageSlug)
          .sort((a, b) => a.createdAt - b.createdAt)
      },

      pagesWithPending: () => {
        const out = new Set<string>()
        for (const c of Object.values(get().byId)) {
          if (c.status === 'pending') out.add(c.pageSlug)
        }
        return out
      },
    }),
    {
      name: 'writer-tauri:pending-changes',
      version: 1,
      // Persist the queue across reloads so a user who closes the
      // app mid-review doesn't lose pending changes. Only the data
      // — not the selector functions — survives serialisation.
      partialize: (s) => ({ byId: s.byId }),
    },
  ),
)

// Dev-only console handle so the store is inspectable from DevTools:
//   __pendingChanges.list()     — all entries
//   __pendingChanges.pending()  — only pending
//   __pendingChanges.state()    — full state
if (import.meta.env.DEV) {
  ;(window as unknown as { __pendingChanges: Record<string, unknown> }).__pendingChanges = {
    list: () => Object.values(usePendingChangesStore.getState().byId),
    pending: () =>
      Object.values(usePendingChangesStore.getState().byId).filter(
        (c) => c.status === 'pending',
      ),
    state: () => usePendingChangesStore.getState(),
  }
}
