// Selects which chat threads contribute to a single ingest pass, and
// returns each one as a (title, summary) pair ready to drop into the
// system prompt. Two filters in order:
//
//   1. Activity filter — keep only threads whose most recent turn is
//      newer than `sinceTs` (= ingestStore.lastIngestAt, injected by
//      the caller). Threads frozen since the previous ingest were
//      already digested last pass; re-feeding them is noise.
//
//   2. Cache check — for each surviving thread, compare its
//      `aiSummaryUpToTurnId` against the live last turn id.
//        - Match  → reuse `aiSummary` (no LLM call).
//        - Miss   → recompact via compactChatThread (one LLM call).
//
// Cost is proportional to the user's actual chat activity: zero
// LLM calls for a quiet day, one call per thread that grew since
// the last ingest. Recompaction calls fan out in parallel so the
// total latency is bounded by the slowest single call, not the sum.
//
// First-run caveat: on the very first ingest after this code lands
// `sinceTs` will be 0 (the field is absent from ingestStore), so
// every existing thread passes the activity filter and gets
// summarized. That's intentional — a one-time backfill so the
// wiki captures pre-existing chat history.

import type { ThreadMeta } from '@/chat/types'
import { useThreadsStore } from '@/state/threadsStore'
import { compactChatThread } from './compactChatThread'

export interface ActiveThreadSummary {
  threadTitle: string
  summary: string
}

export interface SelectActiveThreadsArgs {
  /** Doc slug whose threads should be considered. Only threads
   * anchored to this slug (`parentSlug === slug`) are processed. */
  slug: string
  /** Wall-clock ms cutoff for "had activity since". Threads whose last
   * turn timestamp is ≤ this value are skipped. Pass 0 to include
   * every non-archived thread (first-run backfill). */
  sinceTs: number
}

export async function selectActiveThreadsForIngest(
  args: SelectActiveThreadsArgs,
): Promise<ActiveThreadSummary[]> {
  const { slug, sinceTs } = args
  const state = useThreadsStore.getState()
  const allThreads = Object.values(state.threads).filter(
    (t) => t.parentSlug === slug,
  )

  // Activity filter — read each thread's turns once, snapshot the
  // last turn (id + ts) so the cache check below doesn't re-read.
  type Active = { meta: ThreadMeta; lastTurnId: string }
  const active: Active[] = []
  for (const meta of allThreads) {
    if (meta.archived) continue
    const turns = state.turns[meta.id] ?? []
    if (turns.length === 0) continue
    const last = turns[turns.length - 1]
    if (last.ts <= sinceTs) continue
    active.push({ meta, lastTurnId: last.id })
  }
  if (active.length === 0) return []

  // Cache check + recompact (parallel). Each branch resolves to
  // either a ready summary or null (compactChatThread failure).
  const results = await Promise.all(
    active.map(async ({ meta, lastTurnId }): Promise<ActiveThreadSummary | null> => {
      let summary: string | null
      if (meta.aiSummary && meta.aiSummaryUpToTurnId === lastTurnId) {
        summary = meta.aiSummary
      } else {
        summary = await compactChatThread(meta.id)
      }
      if (!summary) return null
      const title = meta.title.trim() || 'Untitled thread'
      return { threadTitle: title, summary }
    }),
  )

  return results.filter((r): r is ActiveThreadSummary => r !== null)
}
