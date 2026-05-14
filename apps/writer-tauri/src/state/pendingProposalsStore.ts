// Per-slug queue for chat proposals whose target editor was unmounted
// before the proposal arrived. A run started in doc A and continuing
// after the user switches to doc B will land here for doc A; the next
// time MilkdownEditor mounts for that slug, it drains the queue and
// applies them through the normal applyProposal path.
//
// Lives outside React so chat.ts (non-React) can enqueue directly.
// Cleared when the owning doc is closed or archived — see docsStore.

import { create } from 'zustand'
import type { Proposal } from '@/agent/proposals'
import type { ApplyMeta, ApplyOutcome } from '@/agent/applyProposal'

export interface PendingProposalEntry {
  proposal: Proposal
  meta: ApplyMeta
  queuedAt: number
}

interface PendingProposalsState {
  queues: Record<string, PendingProposalEntry[]>
  enqueue: (slug: string, proposal: Proposal, meta: ApplyMeta) => void
  /** Atomically swap out the queue for `slug` and hand it to `apply`.
   * Returning the entries via callback (rather than letting the caller
   * read + clear) keeps drain idempotent against Strict Mode's double
   * mount: a second concurrent drain sees an empty queue. */
  drain: (
    slug: string,
    apply: (entry: PendingProposalEntry) => ApplyOutcome,
  ) => ApplyOutcome[]
  clear: (slug: string) => void
  size: (slug: string) => number
}

export const usePendingProposals = create<PendingProposalsState>((set, get) => ({
  queues: {},
  enqueue: (slug, proposal, meta) => {
    set((s) => {
      const prev = s.queues[slug] ?? []
      return {
        queues: {
          ...s.queues,
          [slug]: [...prev, { proposal, meta, queuedAt: Date.now() }],
        },
      }
    })
  },
  drain: (slug, apply) => {
    const entries = get().queues[slug]
    if (!entries || entries.length === 0) return []
    set((s) => {
      if (!s.queues[slug]) return s
      const next = { ...s.queues }
      delete next[slug]
      return { queues: next }
    })
    return entries.map((e) => apply(e))
  },
  clear: (slug) => {
    set((s) => {
      if (!s.queues[slug]) return s
      const next = { ...s.queues }
      delete next[slug]
      return { queues: next }
    })
  },
  size: (slug) => get().queues[slug]?.length ?? 0,
}))
