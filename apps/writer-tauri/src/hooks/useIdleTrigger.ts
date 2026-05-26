// Wiki ingest triggers — when to fire a pass against a daily note.
//
// Karpathy's LLM wiki pattern is "user drops a source, tells the
// LLM to process it" — a deliberate user-initiated event. Earlier
// versions of this hook automated the trigger (5-min idle, then
// active-doc-change + 30-min polling) which caused chained
// problems: small per-pass contexts made the LLM judge content as
// "transient" more often, every pass still emitted a log line,
// and "no durable content" entries piled up in wiki:log.
//
// Now the trigger is user-initiated by default:
//
//   1. `syncTodayManually()` — exposed for the sidebar Sync
//      button. The deliberate path. One ingest per click.
//   2. 23:59 single-shot timer — safety net for forgotten days.
//      Fires once per day with today's daily as the target. If
//      the user already synced manually, the block-hash filter
//      short-circuits (no new blocks → no LLM call).
//   3. Boot-time catch-up — if yesterday's daily was edited but
//      never ingested (app closed overnight before 23:59 fired),
//      run one pass against it.
//
// Source-side dedup (`lib/blockHash`) stays as insurance: the two
// automatic surfaces above can technically double-fire (manual at
// 5 PM + 23:59 timer), and block-hash ensures the second call is
// a no-op without burning tokens. On the deliberate path it never
// kicks in.
//
// Mounted once at app root via `useIdleTrigger()` (name kept for
// the call site even though the idle policy is gone).

import { useEffect, useRef } from 'react'
import { runIngest } from '@/agent/ingest/index'
import { mapIngestProposalToPendingChange } from '@/agent/ingest/toPendingChange'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { assembleProposalMarkdown } from '@/agent/ingest/markdown'
import {
  appendMarkdownToWikiPage,
  appendToSystemLog,
  buildIngestCommitBody,
  type AppliedProposalForCommit,
} from '@/agent/applyIngest'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useIngestStore } from '@/state/ingestStore'
import { useGitStore } from '@/state/gitStore'
import { createCustomWikiPage } from '@/state/wikiService'
import type { IngestProposal } from '@/agent/ingest/types'
import { resolveWikilinksInMarkdown } from '@/lib/wikilinkResolve'
import { flushDirty } from '@/lib/docFileSync'
import { effectiveLength } from '@/lib/markdownText'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { extractErrorCode } from '@/chat/utils/errorMessage'
import { notify } from '@/lib/notify'
import { useConnectDialog } from '@/stores/connectDialog'

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
    // Assemble the bullets into markdown. The new page is born
    // about this entity, so its body skips the `### {entity}`
    // sub-heading — the page title already carries the topic, and
    // a heading inside the body would render redundantly under it.
    //
    // Append a provenance footer so the page is born showing where
    // its content came from. The user can verify the routing at a
    // glance (e.g. "this is Alex's career — why is it on a Chris
    // page?") and either keep the page or archive it. They can
    // delete the footer themselves once they've confirmed.
    //
    // resolveWikilinks rewrites [[Other Page]] tokens to real
    // markdown links — without this the LLM-emitted brackets land
    // as literal text in the new page's body. Only the assembled
    // bullet content is rewritten; sourceQuote stays verbatim
    // because it mirrors the user's note (no LLM-side rewriting
    // allowed there).
    const assembled = assembleProposalMarkdown(p, { withEntityHeading: false })
    const resolvedContent = resolveWikilinksInMarkdown(assembled)
    // First line of the body MUST be the page title as a level-1
    // heading. The title-mirror (installTitleMirror) walks the first
    // non-empty block and copies its plain text into knownDocs.title,
    // so the sidebar / palette / breadcrumb read it as the page name.
    // Without this heading the mirror would catch the first bullet
    // ("- 새 매니저로 합류") and rename the page to that. This is
    // the regression the previous title-input pattern worked around;
    // doing the same thing as a body-first heading aligns wiki and
    // writing pages on one rule ("body first line is the title").
    const titleHeading = `# ${p.suggestNewPage?.trim() ?? p.entity}`
    const provenanceFooter = p.sourceQuote
      ? `\n\n---\n*From ${sourceLabel}:*\n> ${p.sourceQuote}`
      : ''
    const body = `${titleHeading}\n\n${resolvedContent}${provenanceFooter}`

    // Karpathy-style flat wiki: every entity is its own page at
    // the same level. We deliberately don't pass a parent — the
    // sidebar shows the catalog as a flat list and the LLM finds
    // pages via the WIKI / INDEX blocks, not via tree navigation.
    const newSlug = await createCustomWikiPage(name, body)
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
/** Effective length of the doc's body, client-side.
 *
 * Phase 3.A — replaced the proof-server round-trip. Same reasoning
 * as readDocMarkdown in agent/ingest.ts: the server's markdown
 * column is wedged at empty due to a deriveMarkdownFromFragment
 * crash on our client's Y.XmlFragment, so a client-side read is
 * the only path that reflects what the user actually typed.
 *
 * Reads from the live PM doc when the slug is active, otherwise
 * from the Y.XmlFragment. Returns 0 when no handle exists. */
function readDocLength(slug: string): number {
  const docs = useDocsStore.getState()
  const handle = docs.handles[slug]
  if (!handle) return 0

  if (getActiveSlugFromHash() === slug) {
    const view = useEditorViewStore.getState().view
    if (view) return effectiveLength(view.state.doc.textContent)
  }

  // Phase 5a of the Yjs-removal migration: count characters off the
  // `handle.bodyMarkdown` cache instead of the Y.Doc fragment's flat
  // toString. The cache is the same content the editor seeded PM
  // with, so the visible-character count stays accurate.
  return effectiveLength(handle.bodyMarkdown)
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

  const length = readDocLength(slug)
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
    // Two failure surfaces, gated by trigger kind:
    //
    //   AUTH         — always surface. The OAuth token expired and
    //                  no future pass can succeed until the user
    //                  reconnects, regardless of how the pass was
    //                  triggered.
    //   Other errors — surface ONLY on manual triggers (opts.force).
    //                  The user just clicked sync and expects feedback;
    //                  staying silent looks like the click did nothing.
    //                  For auto-trigger (23:59 fallback) we keep the
    //                  silence — NETWORK / RATE_LIMIT / IDLE_TIMEOUT /
    //                  SIDECAR_DIED / malformed all clear on the next
    //                  idle window, so toasting them would be noise.
    //
    // Same AUTH classifier (`extractErrorCode`) the chat ErrorCard uses,
    // so the two surfaces agree on what counts as auth.
    if (extractErrorCode(err) === 'AUTH') {
      notify.claudeSessionExpired({
        onReconnect: () => useConnectDialog.getState().setOpen(true),
      })
    } else if (opts.force) {
      notify.wikiSyncFailed()
    }
    // Negative sentinel so manual callers can distinguish error
    // from "0 proposals on success" — without it the WikiSection
    // sidebar button would chain a misleading "Synced — nothing
    // new today" toast right after the failure toast.
    return -1
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
  // Karpathy's invariant: 1 ingest = 1 meaningful wiki diff = 1
  // log line. If a pass produces no proposals, the LLM looked at
  // the daily and judged nothing worth filing — its logEntry (when
  // emitted at all) would just be a per-pass "nothing notable"
  // verdict that piles up in wiki:log over time. Suppress the
  // entire enqueue so the log page only ever shows real wiki
  // changes. The console line above still records the pass for
  // diagnostics — the audit trail moves from a user-visible page
  // to dev tooling, which is where it belongs.
  if (result.proposals.length === 0) {
    console.log('[ingest:producer] empty result — suppressing logEntry to keep wiki:log clean', {
      hadLogEntry: !!result.logEntry,
    })
    return 0
  }

  // (Pre-2.A note: wiki:log used to be ensured here so its drain
  // queue could find the target. Phase 2.A inlines logging into
  // `appendToSystemLog`, which ensures the page itself.)

  // Materialize any `suggestNewPage` proposals into real wiki pages
  // first. createCustomWikiPage seeds the body, so those proposals
  // are fully landed once materialize returns — only target-bound
  // proposals (`target: wiki:custom-...`) need a follow-up append.
  // Failures (slug clash, IO error) drop the proposal silently.
  const sourceLabel =
    known.type === 'daily' && known.date
      ? `daily/${known.date}`
      : known.title?.trim() || slug
  const { proposals: proposalsForQueue } = await materializeNewPageProposals(
    result.proposals,
    sourceLabel,
  )

  // Phase 2.A — direct write. Each proposal lands in its target
  // wiki page immediately; no review queue, no banner. The log
  // entry (one per ingest, never per-block) appends to system:log.
  // After every page has been touched we kick a synchronous commit
  // with a meaningful subject + a body that names each entity, the
  // source quote, and the LLM's reason. The body is what makes the
  // Review panel card useful: a glance at the card subject says
  // "ingest from daily/X"; expanding reveals the per-entity story.
  //
  // Phase A.5 of the review-UX migration: mirror every applied
  // proposal into `pendingChangesStore` as well — push then
  // immediately `accept`. This dual-write keeps the legacy
  // auto-apply behaviour intact (so users see no UX change yet)
  // while letting the new sidebar dot + future inline review
  // plugin (Phase C) consume the store as their single source of
  // truth. When Phase C lands the `accept` call moves to the
  // user's click and `appendMarkdownToWikiPage` becomes the
  // store-driven apply path; until then this loop is the only
  // producer.
  const applied: AppliedProposalForCommit[] = []
  const groupId = crypto.randomUUID()
  for (const p of proposalsForQueue) {
    if (!p.target) continue
    const targetDoc = useDocsStore
      .getState()
      .knownDocs.find((d) => d.type === p.target && !d.archivedAt)
    if (!targetDoc) {
      console.warn('[ingest:apply] target type not in catalog', p.target)
      continue
    }
    const md = assembleProposalMarkdown(p, { withEntityHeading: true })
    if (!md) continue
    // Mirror into pendingChangesStore BEFORE the disk write so the
    // sidebar dot momentarily turns blue (push) and then settles
    // (accept) — verifying the store wiring on real data without
    // changing user-visible behaviour.
    const changeId = crypto.randomUUID()
    const editId = crypto.randomUUID()
    usePendingChangesStore.getState().push(
      mapIngestProposalToPendingChange(
        {
          proposal: { ...p, target: p.target },
          pageSlug: targetDoc.slug,
          groupId,
          sourceLabel,
          sourceSlug: slug,
        },
        changeId,
        editId,
      ),
    )
    console.log('[pendingChanges] pushed', {
      changeId,
      pageSlug: targetDoc.slug,
      entity: p.entity,
      groupId,
    })
    const ok = await appendMarkdownToWikiPage(targetDoc.slug, md)
    if (ok) {
      applied.push({
        targetTitle: targetDoc.title?.trim() || targetDoc.slug,
        proposal: p,
      })
      // Auto-resolve: until Phase C wires the inline Accept button,
      // every disk write is treated as an implicit user acceptance.
      usePendingChangesStore.getState().accept(changeId)
      console.log('[pendingChanges] auto-accepted', changeId)
    } else {
      usePendingChangesStore.getState().reject(changeId)
      console.log('[pendingChanges] auto-rejected (write failed)', changeId)
    }
  }
  if (result.logEntry) {
    await appendToSystemLog(result.logEntry)
  }
  // flushDirty drains any active-doc PM transactions to .md /
  // .meta.json / .ydoc; commitChangesNow follows with an explicit
  // subject + body so the Review feed shows the ingest as one card
  // rather than a generic "edit: N files" entry from the idle/
  // ceiling timer.
  await flushDirty()
  const subject = `ai-edit: ingest from ${sourceLabel} (${applied.length} page update${applied.length === 1 ? '' : 's'})`
  const body = buildIngestCommitBody(applied, sourceLabel)
  const message = body ? `${subject}\n\n${body}` : subject
  await useGitStore.getState().commitChangesNow(message)
  return result.proposals.length
}

/** Find today's daily entry in the catalog. Returns null when the
 * daily hasn't been bootstrapped yet (rare — bootstrap runs at app
 * start) or has been archived. Used by the manual sync button and
 * the 23:59 fallback timer; both target "the day's daily" rather
 * than the user's currently-active doc. */
function findTodayDaily(): { slug: string } | null {
  const today = todayLocalDate()
  const docs = useDocsStore.getState()
  const found = docs.knownDocs.find(
    (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
  )
  return found ? { slug: found.slug } : null
}

/** Find yesterday's daily entry, used by the boot-time catch-up
 * path. Returns null when there's no yesterday daily — first-time
 * user, or yesterday was a non-writing day. */
function findYesterdayDaily(): { slug: string } | null {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const y = yesterday.getFullYear()
  const m = String(yesterday.getMonth() + 1).padStart(2, '0')
  const d = String(yesterday.getDate()).padStart(2, '0')
  const yDate = `${y}-${m}-${d}`
  const docs = useDocsStore.getState()
  const found = docs.knownDocs.find(
    (doc) => doc.type === 'daily' && doc.date === yDate && !doc.archivedAt,
  )
  return found ? { slug: found.slug } : null
}

/** Manual sync entry point. Resolves today's daily and runs one
 * ingest pass against it. The sidebar Sync button calls this; so
 * does the 23:59 fallback timer below. Returns the proposal count
 * (0 when no new blocks since last sync, or when no daily exists
 * to target) so the caller can shape its UX accordingly — toast
 * copy differs between "synced — 2 new" and "synced — nothing new
 * today". Returns null when there's no daily to target at all
 * (caller can show "no daily to sync" or just stay quiet). */
export async function syncTodayManually(): Promise<number | null> {
  const today = findTodayDaily()
  if (!today) {
    console.log('[ingest:sync] no today daily to target')
    return null
  }
  return runIngestForSlug(today.slug, { force: true })
}

/** Mounts the wiki ingest fallback timers. Call once near the app
 * root. Three things happen here:
 *
 *   1. One-time pruning of stale proposals (left over from
 *      archived pages, legacy seed types, etc.) — same maintenance
 *      sweep the old auto-trigger did.
 *   2. Boot catch-up: if yesterday has a daily and it was edited
 *      since its last successful ingest, fire one pass against
 *      it. This covers the "app was closed overnight before the
 *      23:59 timer could run" case.
 *   3. Daily 23:59 single-shot timer: every day at 23:59 local
 *      time, run sync against today's daily. Block-hash dedup
 *      makes this safe even when the user already pressed the
 *      Sync button earlier in the day (no-op short-circuit).
 *
 * Single-flight guard (`runningRef`) covers the case where the
 * user presses Sync at exactly 23:59 — only one of the two passes
 * actually hits the LLM. */
export function useIdleTrigger(): void {
  const runningRef = useRef(false)

  useEffect(() => {
    useIngestStore.getState().pruneDeadProposals()

    const fire = async (slug: string) => {
      if (runningRef.current) return
      runningRef.current = true
      try {
        await runIngestForSlug(slug)
      } catch (err) {
        console.warn('[ingest:fallback] pass failed', err)
      } finally {
        runningRef.current = false
      }
    }

    // (1) Boot catch-up. Fire-and-forget — we don't want app
    // startup to block on an LLM call. The edit-vs-ingest gate
    // inside runIngestForSlug guarantees we only call the LLM
    // when yesterday's daily actually has new content; otherwise
    // it short-circuits silently.
    const yesterday = findYesterdayDaily()
    if (yesterday) {
      const ingest = useIngestStore.getState()
      const editedAt = ingest.lastEditedAt[yesterday.slug] ?? 0
      const ingestedAt = ingest.lastIngestedAt[yesterday.slug] ?? 0
      if (editedAt > ingestedAt) {
        console.log('[ingest:fallback] boot catch-up: yesterday has unsynced edits')
        void fire(yesterday.slug)
      }
    }

    // (2) 23:59 daily fallback. Compute ms until the next 23:59
    // and use a one-shot setTimeout. After firing, schedule the
    // next 23:59 (24h later, modulo local-time edge cases like
    // DST — Date arithmetic handles those correctly). One-shot is
    // simpler than setInterval here because the wall-clock target
    // moves with the date, not the elapsed-time clock.
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext1159 = () => {
      const now = new Date()
      const next = new Date(now)
      next.setHours(23, 59, 0, 0)
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1)
      }
      const delay = next.getTime() - now.getTime()
      console.log('[ingest:fallback] next 23:59 in', Math.round(delay / 60_000), 'min')
      timer = setTimeout(() => {
        console.log('[ingest:fallback] 23:59 timer firing')
        const today = findTodayDaily()
        if (today) {
          void fire(today.slug).finally(() => {
            scheduleNext1159()
          })
        } else {
          // No daily today (rare — maybe the user hasn't booted
          // the app in days and bootstrap is catching up). Just
          // reschedule and try again tomorrow.
          scheduleNext1159()
        }
      }, delay)
    }
    scheduleNext1159()

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [])
}

// Dev-only console hooks. `__triggerIdle` still hits today's daily
// (same as the manual button) so existing test workflows keep
// working without rewrites. `__syncToday` is the explicit alias
// matching the new function name.
if (import.meta.env.DEV) {
  const w = window as unknown as {
    __triggerIdle: () => Promise<number | null>
    __syncToday: () => Promise<number | null>
  }
  w.__triggerIdle = syncTodayManually
  w.__syncToday = syncTodayManually
}
