// Wiki ingest triggers — when to fire a pass against a daily note.
//
// Replaces the previous 5-minute idle trigger that was firing
// repeatedly on the same growing daily and stamping duplicate
// rows into the wiki. Now we trigger on natural "unit closed"
// signals instead:
//
//   1. Active doc changes away from a daily — the user just
//      finished a writing session on that note, so it's the
//      natural moment to file what they wrote.
//   2. Local date crosses (midnight rollover) — yesterday's
//      daily is permanently sealed by the day boundary even if
//      the user never closes the tab. A 30-minute polling loop
//      detects the crossing.
//
// Source-side dedup (`lib/blockHash`) guards against the case
// where one of these triggers ends up re-processing a daily that
// gained edits since its last successful ingest: only blocks
// whose hash isn't already in `ingestStore.ingestedBlockHashes`
// reach the LLM. The trigger says "look at this note"; the
// block-hash filter decides "and here's the part you haven't
// seen."
//
// Mounted once at app root via `useIdleTrigger()` (name kept for
// the call site even though the idle policy is gone).

import { useEffect, useRef } from 'react'
import { runIngest } from '@/agent/ingest'
import { useDocsStore, isWikiDoc, isUserOwnedWiki } from '@/state/docsStore'
import { useIngestStore } from '@/state/ingestStore'
import {
  ensureLogWikiSlug,
  createCustomWikiPage,
} from '@/state/wikiService'
import type { IngestProposal, IndexUpdate } from '@/agent/ingest'
import { resolveWikilinksInMarkdown } from '@/lib/wikilinkResolve'
import { effectiveLength } from '@/lib/markdownText'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { extractErrorCode } from '@/chat/utils/errorMessage'
import { notify } from '@/lib/notify'
import { useConnectDialog } from '@/stores/connectDialog'

const PROOF_BASE_URL = 'http://localhost:4000'
/** How often to check whether the local date has rolled over.
 * Half-hourly is more than fine — the trigger only needs to fire
 * "eventually after midnight," not at any precise moment. Keeps
 * the polling cost negligible (one Date comparison every 30 min). */
const DATE_POLL_MS = 30 * 60_000

interface RunOptions {
  /** Skip the watermark gate. Used by the dev console hook
   * `__triggerIdle()` so a tester can force a pass without typing
   * 200 chars first. */
  force?: boolean
}

/** Split an ingest pass into "create a new page with this content"
 * vs "append this content to an existing page". The former goes
 * through createCustomWikiPage(name, body) — the page is born with
 * content already in its body, no banner card is needed. The
 * latter is just the existing target-based proposals passed
 * straight through to the queue for in-page banner review.
 *
 * suggestNewPage / target rewrite: when the LLM creates a new
 * page, the indexUpdates entry it emitted references the new page
 * by its proposed `name` (e.g. "Books") since the real type id
 * didn't exist at LLM-call time. We collect a name → realType map
 * here and apply it to indexUpdates below, so by the time the
 * queue sees them every target is a real wiki:* type id and the
 * apply layer can resolve the title via knownDocs.
 *
 * Proposals whose page creation fails are dropped (better to lose
 * one than send the LLM's "make a Books page" content to a random
 * existing target). */
async function materializeNewPageProposals(
  proposals: IngestProposal[],
  sourceLabel: string,
): Promise<{ proposals: IngestProposal[]; nameToType: Map<string, string> }> {
  const out: IngestProposal[] = []
  const nameToType = new Map<string, string>()
  for (const p of proposals) {
    if (p.target) {
      out.push(p)
      continue
    }
    const name = p.suggestNewPage?.trim()
    if (!name) continue
    // Append a provenance footer so the page is born showing where
    // its content came from. The user can verify the routing at a
    // glance (e.g. "this is Alex's career — why is it on a Chris
    // page?") and either keep the page or archive it. They can
    // delete the footer themselves once they've confirmed.
    //
    // resolveWikilinks rewrites [[Other Page]] tokens to real
    // markdown links — without this the LLM-emitted brackets land
    // as literal text in the new page's body. Only the content
    // portion is rewritten; sourceQuote stays verbatim because it
    // mirrors the user's note (no LLM-side rewriting allowed
    // there).
    const resolvedContent = resolveWikilinksInMarkdown(p.content)
    const body = p.sourceQuote
      ? `${resolvedContent}\n\n---\n*From ${sourceLabel}:*\n> ${p.sourceQuote}`
      : resolvedContent

    // Resolve suggestNewPageParent (a page type id) to a slug by
    // exact-equality lookup against the live catalog, limited to
    // user content pages (wiki:custom-*). The system prompt asks
    // the model to copy the id verbatim from the WIKI block
    // header, so there's no title-fallback heuristic — a miss
    // means typo / hallucination and we'd rather log + root-
    // create than guess. createCustomWikiPage runs its own
    // validation too.
    let parentId: string | undefined
    if (p.suggestNewPageParent) {
      const parent = useDocsStore
        .getState()
        .knownDocs.find(
          (d) =>
            !d.archivedAt &&
            isUserOwnedWiki(d) &&
            d.type === p.suggestNewPageParent,
        )
      if (parent) {
        parentId = parent.slug
      } else {
        console.warn(
          '[ingest] suggestNewPageParent did not resolve; creating at root',
          p.suggestNewPageParent,
        )
      }
    }

    const newSlug = await createCustomWikiPage(
      name,
      body,
      parentId ? { parentId } : undefined,
    )
    if (!newSlug) {
      console.warn(
        '[ingest] suggestNewPage failed; dropping proposal',
        name,
      )
      continue
    }
    // Lookup the type id the catalog just assigned (createCustomWikiPage
    // mints a `wiki:custom-<id>` and registers it). Used below to
    // rewrite indexUpdates that referenced this page by name.
    const known = useDocsStore.getState().knownDocs.find((d) => d.slug === newSlug)
    if (known) nameToType.set(name, known.type)
    // Page is now in the catalog with its content already in the
    // body. No queue entry — there's no mark to apply. The user
    // sees the new page in the sidebar; if they don't like it,
    // archiving is a one-click rejection.
  }
  return { proposals: out, nameToType }
}

/** Read a doc's markdown via the canonical proof-server route.
 * Returns '' on failure so the watermark check treats unreachable
 * docs as "no growth" and skips them silently. */
async function readDocLength(slug: string): Promise<number> {
  try {
    const res = await fetch(
      `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}`,
    )
    if (!res.ok) return 0
    const json = (await res.json()) as { markdown?: string }
    return effectiveLength(json.markdown ?? '')
  } catch {
    return 0
  }
}

/** Run an ingest pass against a specific note slug. Returns the
 * number of proposals enqueued (0 if skipped or empty). Callers
 * arrange the single-flight guarding at the trigger site — this
 * function is purely the pipeline. */
async function runIngestForSlug(
  slug: string,
  opts: RunOptions = {},
): Promise<number> {
  console.log('[ingest:trigger] start', { force: !!opts.force, slug })
  const docs = useDocsStore.getState()
  const known = docs.knownDocs.find((d) => d.slug === slug)
  if (!known) {
    console.log('[ingest:trigger] bail: slug not in catalog', { slug })
    return 0
  }
  // Agent-managed pages (system:* + wiki:*) are LLM output, not
  // input — ingesting one would feed the wiki's content back into
  // itself. Trigger sites should already filter these out, but
  // guard here so a misplaced call (dev console, future trigger
  // surface) can't accidentally poison the wiki.
  if (isWikiDoc(known)) {
    console.log('[ingest:trigger] bail: slug is agent-managed', { slug, type: known.type })
    return 0
  }
  if (known.archivedAt) {
    console.log('[ingest:trigger] bail: source doc archived', { slug })
    return 0
  }

  const length = await readDocLength(slug)
  if (length === 0) {
    console.log('[ingest:trigger] bail: source doc empty', { slug })
    return 0
  }

  if (!opts.force) {
    // Dirty-bit gate: re-ingest only if the note has been edited
    // since the last successful pass. The XmlFragment observer in
    // docsStore.buildHandle bumps `lastEditedAt[slug]` on any
    // change; `markIngested` below stamps `lastIngestedAt[slug]`
    // on successful return. First ingest (no prior `lastIngestedAt`)
    // always falls through — the length=0 short-circuit above
    // already caught the empty case. This replaces the old growth-
    // based MIN_GROWTH watermark; a small but meaningful edit (a
    // new bullet under an existing entity) used to fall under the
    // 200-char threshold and silently skip.
    const ingest = useIngestStore.getState()
    const editedAt = ingest.lastEditedAt[slug] ?? 0
    const ingestedAt = ingest.lastIngestedAt[slug] ?? 0
    if (ingestedAt > 0 && editedAt <= ingestedAt) {
      console.log('[ingest:trigger] bail: no edits since last ingest', {
        slug,
        editedAt,
        ingestedAt,
      })
      return 0
    }
  }
  console.log('[ingest:trigger] passed gates → calling LLM', { slug, length })

  let result
  try {
    result = await runIngest(slug)
  } catch (err) {
    console.warn('[ingest] runIngest failed', slug, err)
    // Auth errors are the one ingest failure that doesn't auto-
    // recover — the OAuth token has expired and the user must
    // sign in again before any future pass can succeed. Surface
    // it as a toast with a Reconnect action so the silent
    // background failure becomes visible. Every other error
    // (NETWORK / RATE_LIMIT / IDLE_TIMEOUT / SIDECAR_DIED /
    // malformed / transient 5xx) clears on the next idle window
    // without user action, so interrupting them with a toast
    // would be noise. Same classifier (`extractErrorCode`) the
    // chat ErrorCard uses, so the two surfaces agree on what
    // counts as auth.
    if (extractErrorCode(err) === 'AUTH') {
      notify.claudeSessionExpired({
        onReconnect: () => useConnectDialog.getState().setOpen(true),
      })
    }
    return 0
  }
  // Update the watermark unconditionally on a successful call —
  // even an empty proposal set means "we looked at this length and
  // judged nothing notable", and re-asking on the same content
  // would be wasted tokens.
  useIngestStore.getState().markIngested(slug, length)
  // Persist the block-hash snapshot so the next pass can filter
  // already-seen blocks out before the LLM ever sees them. Skip
  // on malformed runs (the LLM didn't actually consume anything;
  // we want to retry the same content next time). Empty arrays
  // are fine to store — they correctly reflect a doc with no
  // hashable blocks.
  if (!result.malformed) {
    useIngestStore.getState().setIngestedBlockHashes(slug, result.ingestedHashes)
  }
  // Sweep out any proposals that target archived / no-longer-extant
  // pages. Cheap, idempotent, and keeps the queue from accumulating
  // legacy targets across schema changes.
  useIngestStore.getState().pruneDeadProposals()

  if (result.malformed) {
    console.warn('[ingest:producer] malformed response, skipping enqueue', result.raw)
    return 0
  }
  if (result.proposals.length === 0 && !result.logEntry) {
    console.log('[ingest:producer] empty result (no proposals, no logEntry) — nothing to enqueue')
    return 0
  }

  // wiki:log is the only system-owned wiki page and is created
  // lazily on first need. Without this, a logEntry would queue but
  // never drain because the target doc wouldn't exist in the
  // catalog for the user to navigate to.
  if (result.logEntry) {
    await ensureLogWikiSlug()
  }

  // Materialize any `suggestNewPage` proposals into real wiki pages
  // before enqueue, so by the time the user clicks the sidebar
  // entry the doc is already in the catalog (and the pending
  // proposal already points at it via target).
  // Failures (e.g. proof-server unreachable) drop the proposal
  // rather than silently re-routing it elsewhere.
  const sourceLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || slug
  const { proposals: proposalsForQueue, nameToType } =
    await materializeNewPageProposals(result.proposals, sourceLabel)

  // Rewrite indexUpdates so every target is a real wiki:* type id.
  // The LLM emitted them with the new page's *name* (e.g. "Books")
  // when it didn't have an id yet; materializeNewPageProposals just
  // created the real pages and gave us the name → type map. Drop
  // any indexUpdate whose name didn't resolve — the matching page
  // creation must have failed, so its summary line has nothing to
  // anchor to.
  const validTypes = new Set<string>(
    useDocsStore
      .getState()
      .knownDocs.filter((d) => !d.archivedAt)
      .map((d) => d.type),
  )
  const indexUpdatesForQueue: IndexUpdate[] = []
  for (const u of result.indexUpdates) {
    if (validTypes.has(u.target)) {
      indexUpdatesForQueue.push(u)
      continue
    }
    const rewritten = nameToType.get(u.target)
    if (rewritten) {
      indexUpdatesForQueue.push({ target: rewritten, summary: u.summary })
    } else {
      console.warn(
        '[ingest] indexUpdate target did not resolve to a real page; dropping',
        u.target,
      )
    }
  }

  useIngestStore.getState().enqueue({
    proposals: proposalsForQueue,
    indexUpdates: indexUpdatesForQueue,
    logEntry: result.logEntry,
    sourceSlug: slug,
    sourceLabel,
  })
  return result.proposals.length
}

/** Wrapper that resolves "the active note" → slug and dispatches to
 * runIngestForSlug. Kept around as the dev-console entry point
 * (__triggerIdle) and as the obvious "run on the user's current
 * focus" call for any future surface. Returns 0 when there's no
 * active doc or the active doc is a wiki page (no daily fallback —
 * the explicit triggers below handle the wiki-active scenario by
 * targeting yesterday's daily directly). */
async function runActiveIngest(opts: RunOptions = {}): Promise<number> {
  const slug = useDocsStore.getState().activeSlug
  if (!slug) {
    console.log('[ingest:trigger] active: no slug')
    return 0
  }
  return runIngestForSlug(slug, opts)
}

/** Mounts the wiki ingest triggers. Call once near the app root.
 *
 * Two firing conditions, each independent:
 *
 *   1. activeSlug subscription — when the user navigates away from
 *      a daily (or any non-wiki note), ingest the slug they just
 *      left. The block-hash filter (see `lib/blockHash`) ensures
 *      we only forward newly-written content even if the user
 *      bounces in and out of the same daily multiple times.
 *   2. Date polling — every 30 minutes, compare today's local
 *      date against the last date we processed. On a crossing,
 *      ingest yesterday's daily so the day's writing reliably
 *      gets filed even if the user never switched tabs.
 *
 * Both share a single in-flight guard (`runningRef`) — wiki state
 * isn't safe to mutate from two concurrent passes against the
 * same source. */
export function useIdleTrigger(): void {
  const runningRef = useRef(false)

  useEffect(() => {
    // One-time sweep at app start so any persisted proposals
    // pointing at types that no longer exist (archived pages,
    // legacy seeds) drop out of the queue before the user sees a
    // stale review card.
    useIngestStore.getState().pruneDeadProposals()

    const fire = async (slug: string) => {
      if (runningRef.current) return
      runningRef.current = true
      try {
        await runIngestForSlug(slug)
      } catch (err) {
        console.warn('[ingest] trigger pass failed', err)
      } finally {
        runningRef.current = false
      }
    }

    // (1) activeSlug subscription. Zustand fires the callback with
    // (current, previous) on every state change; we filter to the
    // slug field and ignore renders where it didn't actually move.
    // We ingest the *previous* slug — that's the note the user
    // just finished with. Skip when the outgoing doc isn't a
    // user-authored source (wiki:* / system:* are agent output).
    const unsubActive = useDocsStore.subscribe((state, prev) => {
      if (state.activeSlug === prev.activeSlug) return
      const leaving = prev.activeSlug
      if (!leaving) return
      const known = state.knownDocs.find((d) => d.slug === leaving)
      if (!known || isWikiDoc(known) || known.archivedAt) return
      void fire(leaving)
    })

    // (2) Date polling for midnight rollover. lastDate starts as
    // "today at mount time"; the first crossing detected is when
    // the *next* day arrives. We fire against yesterday's daily —
    // the unit that just closed — which lets a user who left the
    // app open overnight still get the previous day's writing
    // filed without re-opening the tab.
    let lastDate = todayLocalDate()
    const checkDate = () => {
      const now = todayLocalDate()
      if (now === lastDate) return
      const yesterday = lastDate
      lastDate = now
      console.log('[ingest:trigger] date crossed', { from: yesterday, to: now })
      const docs = useDocsStore.getState()
      const yesterdayDaily = docs.knownDocs.find(
        (d) => d.type === 'daily' && d.date === yesterday && !d.archivedAt,
      )
      if (!yesterdayDaily) {
        console.log('[ingest:trigger] no yesterday daily to ingest', { yesterday })
        return
      }
      void fire(yesterdayDaily.slug)
    }
    const dateTimer = setInterval(checkDate, DATE_POLL_MS)

    return () => {
      unsubActive()
      clearInterval(dateTimer)
    }
  }, [])
}

// Dev-only console hook so a tester can fire an ingest immediately
// without waiting for a trigger event. Hits the active doc, skips
// the edit watermark; the block-hash filter still applies (force
// means "ignore timing gates," not "send duplicates").
if (import.meta.env.DEV) {
  ;(window as unknown as { __triggerIdle: () => Promise<number> }).__triggerIdle =
    () => runActiveIngest({ force: true })
}
