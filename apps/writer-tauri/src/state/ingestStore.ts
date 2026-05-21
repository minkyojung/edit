// Ingest review queue — holds wiki proposals produced by the idle
// trigger until the user reviews them. Karpathy "Memories" pattern:
// the user keeps writing without interruption, the LLM works in the
// background, and a small card shows up at the next natural pause to
// surface what's accumulated.
//
// Three things live here:
//
// 1. `pendingProposals` — proposals waiting for the user to accept
//    or skip. Each carries a stable `id` so the review modal can
//    track per-row checkbox state across re-renders.
// 2. `lastIngestedAt` / `lastIngestedLength` — per-note watermark so
//    we don't re-ingest a note whose body hasn't grown meaningfully
//    since the last pass. Idle trigger consults this before calling
//    runIngest.
// 3. `dismissed` — soft hide for the welcome card. Re-opens
//    automatically the next time fresh proposals land.
//
// Persisted across reloads so a user who closes the app mid-review
// doesn't lose the queue. The `applySelected` and `dismiss` flows
// happen synchronously here; the actual ydoc append is the caller's
// job (wiki write happens in PR 3-2 step 5).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { IngestProposal } from '@/agent/ingest/types'
import { useDocsStore } from './docsStore'

/** A proposal waiting for the user to accept or skip. Adds a stable
 * id (so the review modal's checkbox state is keyed reliably) and
 * provenance (which note this came from, so the modal can group). */
export interface PendingProposal extends IngestProposal {
  id: string
  /** Slug of the note this proposal was derived from. Used to group
   * "today's daily produced 3 ideas" in the review modal. */
  sourceSlug: string
  /** Display label for the source — usually `daily/YYYY-MM-DD` or
   * the writing note's title. Cached at queue time so the modal
   * doesn't have to look it up on every render. */
  sourceLabel: string
  /** ms since epoch when the LLM produced this proposal. Used to
   * order rows newest-last and to age-out stale proposals if the
   * user lets them sit for days. */
  proposedAt: number
}

/** A pending log entry that lives alongside its proposals. The LLM
 * always emits one log line per ingest pass; we keep it separate
 * from `pendingProposals` because applying log != applying wiki
 * edits (the user might Skip All proposals but still want the log
 * to record that an ingest pass happened). */
export interface PendingLogEntry {
  id: string
  sourceSlug: string
  /** The pre-formatted log line (`## [DATE] ingest | ...`). Goes
   * straight into wiki:log on apply. */
  line: string
  proposedAt: number
}

interface IngestState {
  // Persisted
  pendingProposals: PendingProposal[]
  pendingLogs: PendingLogEntry[]
  /** @deprecated Old growth-based watermark. Superseded by the
   * lastEditedAt / lastIngestedAt pair below — left in the interface
   * so existing persisted state rehydrates without runtime warnings;
   * new code paths never read or write it. */
  lastIngestedLength: Record<string, number>
  /** Per-note ms-since-epoch of the most recent observed edit to the
   * note body. Bumped by an XmlFragment observer installed in
   * docsStore.buildHandle once IDB has finished hydrating (so the
   * initial replay doesn't register as a fresh edit). Idle trigger
   * compares this against `lastIngestedAt[slug]` — if the doc has
   * been edited since the last successful ingest, it becomes a
   * candidate again, no matter how small the edit was. */
  lastEditedAt: Record<string, number>
  /** Per-note ms-since-epoch of the most recent successful ingest
   * pass. Set after the LLM returns valid output (even when the
   * output had zero proposals — "we looked and judged nothing"
   * still counts). Used as the watermark the idle trigger compares
   * `lastEditedAt` against. */
  lastIngestedAt: Record<string, number>
  /** Per-note hashes of markdown blocks already forwarded to the
   * LLM in some prior ingest pass. Persisted as `string[]` because
   * Set isn't JSON-serializable; runIngest builds a Set at use
   * time for O(1) membership tests. Re-stored as the full current
   * hash list after each pass — that "current snapshot, not
   * cumulative log" shape lets deletions self-heal (a paragraph
   * dropped from the body falls out of the hash set, so re-paste
   * is correctly treated as new content). */
  ingestedBlockHashes: Record<string, string[]>
  dismissed: boolean
  /** Idle minutes before the trigger fires. User-configurable;
   * defaults to 5 (matches Karpathy "step away briefly" cadence). */
  idleMinutes: number

  // Actions
  /** Append fresh proposals from one ingest pass. Wakes the card
   * (clears `dismissed`) so the user notices the new batch. */
  enqueue: (args: {
    proposals: IngestProposal[]
    logEntry: string | null
    sourceSlug: string
    sourceLabel: string
  }) => void
  /** Drop the listed proposal / log ids from the queue (after they've
   * been applied OR explicitly skipped — same operation either way). */
  remove: (args: {
    proposalIds: string[]
    logIds?: string[]
  }) => void
  /** Update a single proposal in place. Used by the apply layer
   * when it materializes a `suggestNewPage` proposal — it creates
   * the new wiki page, then patches the proposal's `target` to the
   * new doc's type id and clears `suggestNewPage` so the rest of
   * the apply path treats it like any other proposal. No-op if the
   * id isn't found. */
  patchProposal: (id: string, patch: Partial<PendingProposal>) => void
  /** Drop proposals whose target type isn't in the live catalog
   * (page archived since enqueue, legacy seed-page targets like
   * `wiki:people` left over from before the seed pages were
   * removed, etc.). Without this, dead proposals sit in the queue
   * forever — the banner inbox simply never shows them because
   * the target page can't be opened. Idempotent; safe to call on
   * every idle pass. */
  pruneDeadProposals: () => void
  /** Hide the card without touching the queue. Reopens automatically
   * the next time enqueue lands new content. */
  dismiss: () => void
  /** Force the card open — used by tests / dev console. */
  undismiss: () => void
  /** User-configurable idle interval. Clamped to [1, 60] minutes so
   * a stray dev-tools edit can't accidentally schedule an ingest
   * every second or once a day. */
  setIdleMinutes: (n: number) => void
  /** Stamp `lastEditedAt[slug]` to now. Called by the XmlFragment
   * observer installed per-handle so any observed edit (typing,
   * remote sync, mark accept) makes the note re-eligible for the
   * next idle pass. No-op for wiki:* slugs — those aren't ingest
   * sources, bumping their state would waste persistence writes. */
  markEdited: (slug: string) => void
  /** Update the per-note watermarks after a successful ingest pass.
   * Sets `lastIngestedAt[slug]` so the next idle pass compares
   * `lastEditedAt` against this fresh value. The `bodyLength` arg
   * is legacy (used to populate the deprecated length-based gate);
   * still recorded for diagnostics but no live gate reads it. */
  markIngested: (slug: string, bodyLength: number) => void
  /** Replace the persisted block-hash snapshot for `slug`. Called
   * after a successful ingest pass with the *full* current hash
   * list of the note's body (not just the newly-sent blocks) — see
   * the field comment for why the cumulative-vs-snapshot shape
   * matters for deletion handling. Separate from markIngested
   * because the two persistences carry different concerns
   * (timestamp vs content fingerprint) and update independently
   * during force-runs. */
  setIngestedBlockHashes: (slug: string, hashes: string[]) => void
  /** Wipe all pending state. Useful for a "clear queue" affordance
   * and for tests. */
  reset: () => void
}

const MIN_IDLE = 1
const MAX_IDLE = 60
const DEFAULT_IDLE = 5

export const useIngestStore = create<IngestState>()(
  persist(
    (set) => ({
      pendingProposals: [],
      pendingLogs: [],
      lastIngestedLength: {},
      lastEditedAt: {},
      lastIngestedAt: {},
      ingestedBlockHashes: {},
      dismissed: false,
      idleMinutes: DEFAULT_IDLE,

      enqueue: ({ proposals, logEntry, sourceSlug, sourceLabel }) => {
        console.log('[ingest:queue] enqueue called', {
          proposals: proposals.length,
          logEntry: !!logEntry,
          sourceSlug,
          targets: proposals.map((p) => p.target ?? `new:${p.suggestNewPage}`),
        })
        if (proposals.length === 0 && !logEntry) return
        const now = Date.now()
        const newProposals: PendingProposal[] = proposals.map((p) => ({
          ...p,
          id: crypto.randomUUID(),
          sourceSlug,
          sourceLabel,
          proposedAt: now,
        }))
        // Log lines queue alongside proposals and apply lazily when
        // the user navigates to wiki:log — same lazy-on-active
        // pattern marks use. We tried auto-applying via direct ydoc
        // writes earlier; the server's projection guardrail repaired
        // them away because raw XmlFragment inserts don't match the
        // shape PM transactions produce. Funneling through the
        // editor view is the only durable path.
        const newLogs: PendingLogEntry[] = logEntry
          ? [
              {
                id: crypto.randomUUID(),
                sourceSlug,
                line: logEntry,
                proposedAt: now,
              },
            ]
          : []
        if (newProposals.length === 0 && newLogs.length === 0) return
        set((s) => ({
          pendingProposals: [...s.pendingProposals, ...newProposals],
          pendingLogs: [...s.pendingLogs, ...newLogs],
          // Wake the card on every fresh batch so the user notices
          // the new wiki additions waiting for review.
          dismissed: false,
        }))
        console.log('[ingest:queue] enqueued', {
          newProposals: newProposals.length,
          newLogs: newLogs.length,
          ids: newProposals.map((p) => p.id),
        })
      },

      remove: ({ proposalIds, logIds }) => {
        const propSet = new Set(proposalIds)
        const logSet = new Set(logIds ?? [])
        set((s) => ({
          pendingProposals: s.pendingProposals.filter(
            (p) => !propSet.has(p.id),
          ),
          pendingLogs: s.pendingLogs.filter((l) => !logSet.has(l.id)),
        }))
      },

      patchProposal: (id, patch) => {
        set((s) => ({
          pendingProposals: s.pendingProposals.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }))
      },

      pruneDeadProposals: () => {
        const validTypes = new Set<string>(
          useDocsStore
            .getState()
            .knownDocs.filter((d) => !d.archivedAt)
            .map((d) => d.type as string),
        )
        set((s) => {
          const next = s.pendingProposals.filter(
            (p) => !!p.target && validTypes.has(p.target),
          )
          if (next.length === s.pendingProposals.length) return s
          console.log(
            `[ingest] pruned ${s.pendingProposals.length - next.length} dead proposals`,
          )
          return { ...s, pendingProposals: next }
        })
      },

      dismiss: () => set({ dismissed: true }),
      undismiss: () => set({ dismissed: false }),

      setIdleMinutes: (n) => {
        const clamped = Math.max(MIN_IDLE, Math.min(MAX_IDLE, Math.round(n)))
        set({ idleMinutes: clamped })
      },

      markEdited: (slug) => {
        // Caller is responsible for type-gating (slug is a random
        // UUID, not a type id, so prefix checks here never matched).
        // docsStore's XmlFragment observer in `buildHandle` filters
        // agent-managed pages via `isWikiDoc(known)` before calling
        // in, so this just records the timestamp.
        set((s) => ({
          lastEditedAt: { ...s.lastEditedAt, [slug]: Date.now() },
        }))
      },

      markIngested: (slug, bodyLength) =>
        set((s) => ({
          lastIngestedLength: { ...s.lastIngestedLength, [slug]: bodyLength },
          lastIngestedAt: { ...s.lastIngestedAt, [slug]: Date.now() },
        })),

      setIngestedBlockHashes: (slug, hashes) =>
        set((s) => ({
          ingestedBlockHashes: { ...s.ingestedBlockHashes, [slug]: hashes },
        })),

      reset: () =>
        set({
          pendingProposals: [],
          pendingLogs: [],
          lastIngestedLength: {},
          lastEditedAt: {},
          lastIngestedAt: {},
          ingestedBlockHashes: {},
          dismissed: false,
        }),
    }),
    {
      name: 'writer-tauri:ingest',
      // v4: dropped `pendingIndexUpdates` — the system writes the
      // catalog page directly (state/wikiIndex.ts) so the queue is
      // no longer needed. zustand discards on version mismatch
      // without a migrate; the queue is transient (next ingest
      // re-generates) so a hard reset is acceptable.
      //
      // v3: IngestProposal switched from `content: string` to the
      // atomic `entity: string + bullets: string[]` shape so the
      // model can no longer emit page-level headings inside the
      // payload. Old v2 entries carry `content` and would crash the
      // UI (entity/bullets undefined).
      //
      // v2: adds `ingestedBlockHashes` for source-side dedup.
      version: 4,
      partialize: (s) => ({
        pendingProposals: s.pendingProposals,
        pendingLogs: s.pendingLogs,
        lastIngestedLength: s.lastIngestedLength,
        lastEditedAt: s.lastEditedAt,
        lastIngestedAt: s.lastIngestedAt,
        ingestedBlockHashes: s.ingestedBlockHashes,
        dismissed: s.dismissed,
        idleMinutes: s.idleMinutes,
      }),
    },
  ),
)
