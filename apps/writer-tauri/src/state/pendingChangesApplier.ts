// pendingChangesApplier — translates a user Accept into a real disk
// write. Lives outside `pendingChangesStore` deliberately: the store
// is pure state + status mutations, and disk I/O is a side effect
// that belongs in its own module. The applier subscribes to status
// transitions (`pending → accepted`) and runs the appropriate apply
// path for each `source`.
//
// This is the listener Phase C4 promised. Until it's started no
// Accept does anything to disk — the store still flips status and
// the widget vanishes, but the underlying file is untouched.
// Reject mutations are observed too, but only for diagnostics —
// there's no disk work to do.
//
// Why a free function (not a hook):
//   The applier needs to fire even when no React component has
//   subscribed to the store yet — e.g. on app boot before any
//   editor mounts. A module-level `startPendingChangesApplier()`
//   called once from App.tsx is the simplest shape. Idempotent so
//   StrictMode's double-effect-invocation doesn't double-subscribe.

import { usePendingChangesStore, type PendingChange } from './pendingChangesStore'
import {
  appendMarkdownToWikiPage,
  applyReplaceInWikiPage,
  applyWriteWikiPage,
} from '@/agent/applyIngest'
import { useDocsStore } from './docsStore'
import { isChangeMaterializedInActiveCm } from './activeCmEditor'
import { useGitStore, aiEditSubject, type AiEditType } from './gitStore'
import { notify } from '@/lib/notify'
import { looseFindRange } from '@/lib/looseMatch'

// HMR safety: vite's `import.meta.hot.dispose` fires right before
// the module is replaced. That's the only hook that runs against
// the OLD module instance (where `unsub` still holds the live
// zustand subscription). Cleaning up there is the recommended
// pattern — see Vite docs "HMR API" — and replaces the earlier
// globalThis attempt, which couldn't dispose listeners registered
// before the fix itself was written into the codebase.
let unsub: (() => void) | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null
// One-shot subscription waiting for docs to finish loading so we can drop orphaned
// pending changes (a pageSlug with no catalog doc). Held at module scope so HMR / stop
// can clear it if it hasn't fired yet.
let orphanUnsub: (() => void) | null = null

/** How often the boot-time applier sweeps decided (accepted /
 * rejected) entries past their retention window. The store keeps
 * decided entries around briefly so the Review Panel can show
 * "just now" rows; without this sweep they accumulate forever
 * because `pruneDecided` was defined but never invoked. */
const PRUNE_INTERVAL_MS = 60_000

/** Per-change apply path. Returns true on success so the caller
 * (or future retry logic) can tell whether the work took.
 *
 * Phase E6 host-applies: both `chat` and `ingest` write disk
 * directly via the same helpers — `applyReplaceInWikiPage`,
 * `applyWriteWikiPage`, `appendMarkdownToWikiPage`. The chat path
 * no longer round-trips through the sidecar's canUseTool gate
 * (the LLM uses the custom `propose_*` MCP tools, which return
 * immediately without parking a Promise). One write path,
 * observable from inside the host. */
async function applyAcceptedChange(change: PendingChange): Promise<boolean> {
  // In-buffer review (Cursor-style) OWNS the buffer + the save mirror for changes
  // it's showing: on Keep it deletes the red and the editor writes bodyMarkdown
  // itself. So the applier must NOT also try to place the edit here — its anchor
  // would no longer match (the proposal text is already in the buffer), which only
  // logged a harmless "outdated" warning. Treat as handled.
  if (isChangeMaterializedInActiveCm(change.pageSlug, change.id)) return true

  // Apply each edit to the wiki page's markdown directly — engine-agnostic
  // string ops on the stored body. (CodeMirror loads the body as markdown,
  // so there's no in-editor PM transaction to commit; the former PM "fast
  // path" that dispatched suggestion-mark commits into a live ProseMirror
  // view is gone with the PM editor.)
  // In-editor Keep with an edited green proposal (Cursor-style): the review
  // already computed the final merged document (current doc + edited green,
  // user's outside edits preserved). Apply it verbatim instead of re-deriving
  // from `edits` — that's the whole point, the edited text wouldn't match.
  if (change.resolvedResult != null) {
    return applyWriteWikiPage(change.pageSlug, change.resolvedResult, change.id)
  }

  let allOk = true
  for (const edit of change.edits) {
    if (edit.kind === 'add') {
      if (!edit.after) {
        allOk = false
        continue
      }
      const ok = await appendMarkdownToWikiPage(change.pageSlug, edit.after, change.id)
      if (!ok) allOk = false
      continue
    }
    if (edit.kind === 'replace') {
      // `before` undefined means whole-doc replace (chat Write tool
      // shape — toPendingChange leaves before empty since the SDK
      // would have overwritten the entire file). Route to the
      // wholesale writer; range-replace covers the Edit / MultiEdit
      // shape where `before` carries the literal text to swap.
      if (!edit.before) {
        const ok = await applyWriteWikiPage(change.pageSlug, edit.after ?? '', change.id)
        if (!ok) allOk = false
        continue
      }
      const ok = await applyReplaceInWikiPage(
        change.pageSlug,
        edit.before,
        edit.after ?? '',
        change.id,
      )
      if (!ok) allOk = false
      continue
    }
    if (edit.kind === 'delete') {
      if (!edit.before) {
        allOk = false
        continue
      }
      const ok = await applyReplaceInWikiPage(change.pageSlug, edit.before, '', change.id)
      if (!ok) allOk = false
      continue
    }
    console.warn('[applier] unknown edit kind', edit.kind)
    allOk = false
  }
  return allOk
}

/** Group-level commit coordinator, shared by chat and ingest. As the
 * pending changes of a group (one chat run or one ingest pass, keyed by
 * groupId) are accepted, we collect them and, after a quiet debounce,
 * land them in a single `edit(ai): …` / `ingest(ai): …` commit. Keeps history
 * clean — one run/pass = one commit, not one commit per Keep click. */
const groupTimers = new Map<string, ReturnType<typeof setTimeout>>()
const groupAccepts = new Map<
  string,
  Array<{ pageTitle: string; change: PendingChange }>
>()
const groupSourceLabel = new Map<string, string>()

function scheduleGroupCommit(change: PendingChange, ok: boolean): void {
  const groupId = change.groupId
  if (ok) {
    const accepts = groupAccepts.get(groupId) ?? []
    accepts.push({
      pageTitle: change.pageSlug, // resolved into a real title at commit time
      change,
    })
    groupAccepts.set(groupId, accepts)
    const label =
      change.context.sourceSlug ?? change.context.threadId ?? groupId
    groupSourceLabel.set(groupId, label)
  }
  // Debounce — accept clicks usually arrive in bursts when the user
  // settles a group's worth of changes in a few seconds. Wait for
  // 1.5 s of quiet before committing so we land them as one commit.
  const existing = groupTimers.get(groupId)
  if (existing) clearTimeout(existing)
  groupTimers.set(
    groupId,
    setTimeout(() => {
      groupTimers.delete(groupId)
      const accepts = groupAccepts.get(groupId) ?? []
      groupAccepts.delete(groupId)
      const label = groupSourceLabel.get(groupId) ?? groupId
      groupSourceLabel.delete(groupId)
      if (accepts.length === 0) return
      void commitGroup(label, accepts)
    }, 1500),
  )
}

async function commitGroup(
  sourceLabel: string,
  accepts: Array<{ pageTitle: string; change: PendingChange }>,
): Promise<void> {
  if (accepts.length === 0) return
  // One assistant checkpoint per accepted burst — the reversibility floor.
  // commitChangesNow flushes Y.Doc → disk first and serializes against any
  // concurrent commit (idle organize / turn-end move), so this lands exactly
  // the accepted burst as a single revertible commit. The subject uses the
  // `(ai)`-scoped convention isAiEditCommit matches.
  const source = accepts[0].change.source
  const type: AiEditType = source === 'ingest' ? 'ingest' : 'edit'
  const knownDocs = useDocsStore.getState().knownDocs
  const nameFor = (slug: string) => {
    const doc = knownDocs.find((d) => d.slug === slug)
    return doc?.title?.trim() || doc?.relPath || slug
  }
  // Subject: the edited pages, deduped — so the undo skill can match "undo what
  // you added to Tom".
  const names = [...new Set(accepts.map((a) => nameFor(a.change.pageSlug)))]
  const subject = aiEditSubject(type, names)
  // Body: the per-edit `reason` the model supplied on propose_edit/write — one
  // bullet each (deduped), so the version history says WHY each change happened.
  const reasonLines = [
    ...new Set(
      accepts
        .map((a) => {
          const r = a.change.reason?.trim()
          return r ? `- ${nameFor(a.change.pageSlug)}: ${r}` : null
        })
        .filter((x): x is string => x !== null),
    ),
  ]
  const bodyParts: string[] = []
  if (reasonLines.length > 0) bodyParts.push(reasonLines.join('\n'))
  // Ingest keeps its source note for provenance.
  if (source === 'ingest') bodyParts.push(`Source: ${sourceLabel}`)
  const message = bodyParts.length > 0 ? `${subject}\n\n${bodyParts.join('\n\n')}` : subject
  try {
    await useGitStore.getState().commitChangesNow(message)
  } catch (err) {
    console.warn('[applier] group commit failed', err)
  }
}

/** Track which changes we've already applied so re-entrant store
 * notifications (e.g. zustand firing the listener after our own
 * status flip) don't double-write. */
const handledIds = new Set<string>()

/** Archive the empty note a rejected proposal had materialized, so a declined
 * "new note" leaves no orphan in the sidebar / on disk. Conservative — it skips
 * (keeps the note) when:
 *   - another non-rejected change still targets the same note, or
 *   - the user has since typed their own content into it (bodyMarkdown non-empty).
 * `deleteToTrash` is a soft delete (recoverable via the OS Trash) and refuses
 * system/daily/non-user-owned pages on its own, returning null — in which case
 * we leave it. */
function cleanupRejectedNewNote(change: PendingChange): void {
  const slug = change.pageSlug
  const stillTargeted = Object.values(usePendingChangesStore.getState().byId).some(
    (o) => o.id !== change.id && o.pageSlug === slug && o.status !== 'rejected',
  )
  if (stillTargeted) return
  const docs = useDocsStore.getState()
  const body = docs.handles[slug]?.bodyMarkdown
  if (body != null && body.trim().length > 0) return // user typed real content — keep
  void docs.deleteToTrash(slug).then((result) => {
    if (result === null) {
      console.info('[applier] rejected new note not deletable, left as-is', slug)
    } else {
      console.log('[applier] trashed empty note from rejected proposal', slug)
    }
  })
}

/** Boot-time validation for RESTORED pending changes: `pruneOrphaned` only
 * checks the target SLUG still exists — it doesn't notice a note whose TEXT
 * changed while the app was closed (an external edit, a sync, a git pull).
 * Without this, a stale proposal sits in the tray/cards looking normal and
 * only fails once the user finally clicks Keep. This checks each anchored
 * edit's `before` against the note's CURRENT body, using the same tolerant
 * matcher (`looseFindRange`) the real apply path uses — "still valid" here
 * means the same thing it means at Keep time. Invalid ones are rejected
 * (not silently deleted) so they still flow through the normal decided-entry
 * lifecycle; the user gets ONE batched toast instead of one per suggestion.
 * `add`-kind edits (new-note bodies) have no text anchor, so they're left
 * alone — only file EXISTENCE matters for those, which pruneOrphaned covers. */
async function pruneStaleAnchorsOnce(): Promise<void> {
  const pending = Object.values(usePendingChangesStore.getState().byId).filter(
    (c) => c.status === 'pending',
  )
  const bySlug = new Map<string, PendingChange[]>()
  for (const c of pending) {
    const arr = bySlug.get(c.pageSlug) ?? []
    arr.push(c)
    bySlug.set(c.pageSlug, arr)
  }

  let droppedCount = 0
  for (const [slug, changes] of bySlug) {
    const docs = useDocsStore.getState()
    if (!docs.knownDocs.some((d) => d.slug === slug)) continue // pruneOrphaned's job
    try {
      await docs.ensureHandle(slug)
      await useDocsStore.getState().handles[slug]?.contentReady
    } catch {
      continue // couldn't hydrate this note — leave its changes alone, don't guess
    }
    const body = useDocsStore.getState().handles[slug]?.bodyMarkdown ?? ''
    for (const change of changes) {
      const anchored = change.edits.filter(
        (e): e is typeof e & { before: string } => e.kind !== 'add' && !!e.before,
      )
      if (anchored.length === 0) continue
      const stillValid = anchored.every((e) => looseFindRange(body, e.before) != null)
      if (!stillValid) {
        usePendingChangesStore.getState().reject(change.id)
        droppedCount++
      }
    }
  }
  if (droppedCount > 0) notify.staleProposalsDropped(droppedCount)
}

/** Begin listening. Idempotent within a single module instance —
 * a second call is a no-op. HMR cleanup is handled by the
 * `import.meta.hot.dispose` block below; the next module instance
 * starts with a fresh `unsub === null`. */
export function startPendingChangesApplier(): void {
  if (unsub) return

  // Phase E6 removed the canUseTool-gate flow for chat, so chat
  // pending entries are no longer process-bound and survive
  // restarts the same way ingest entries do. The boot sweep that
  // used to reject stale chat entries (E2.6) is no longer needed.

  // Seed the handled set with anything already decided at startup
  // so the first subscribe call (which fires once on subscribe)
  // doesn't re-apply persisted-decided entries from prior sessions.
  for (const c of Object.values(usePendingChangesStore.getState().byId)) {
    if (c.status !== 'pending') handledIds.add(c.id)
  }

  // Immediate sweep of accepted/rejected entries past retention. Most
  // useful right after launch when a long-running session left a pile
  // of decided rows on disk; the persist middleware rehydrated them
  // but no listener has reaped them yet.
  usePendingChangesStore.getState().pruneDecided()
  // Periodic sweep so the store doesn't grow across a long session.
  // Interval handle is held at module scope so HMR / stop can clear
  // it — without that we'd leak a timer per hot update.
  pruneTimer = setInterval(() => {
    usePendingChangesStore.getState().pruneDecided()
  }, PRUNE_INTERVAL_MS)

  // Drop persisted pending changes whose target page no longer exists — orphans from a
  // prior session or a deleted note. They'd otherwise haunt every surface (review tray,
  // chat cards, sidebar dot) as ghost rows that show a raw slug and can't be opened.
  // pruneOrphaned was defined but never wired; this is its one caller. Run only once
  // docs have finished loading (bootstrapping === false) and never against an empty
  // catalog, so a transient loaded-but-empty state can't nuke every pending change.
  const pruneOrphansOnce = (): boolean => {
    const ds = useDocsStore.getState()
    if (ds.bootstrapping) return false
    const valid = new Set(ds.knownDocs.map((d) => d.slug))
    if (valid.size === 0) return false
    usePendingChangesStore.getState().pruneOrphaned(valid)
    // Once the catalog is real, also check that surviving pending changes'
    // target TEXT still exists — pruneOrphaned above only checked the slug.
    void pruneStaleAnchorsOnce()
    return true
  }
  if (!pruneOrphansOnce()) {
    orphanUnsub = useDocsStore.subscribe(() => {
      if (pruneOrphansOnce()) {
        orphanUnsub?.()
        orphanUnsub = null
      }
    })
  }

  unsub = usePendingChangesStore.subscribe((state) => {
    for (const c of Object.values(state.byId)) {
      if (c.status === 'pending') {
        // Reopened (Cmd-Z undid an accept/reject) — clear the "handled" mark so the
        // NEXT decision re-runs the apply. Without this, re-accepting a change the
        // user undid is silently skipped: the mark clears but the doc never changes
        // and no undoable CM transaction is produced. New pending changes aren't in
        // the set, so this is a no-op for them.
        handledIds.delete(c.id)
        continue
      }
      if (handledIds.has(c.id)) continue
      handledIds.add(c.id)
      if (c.status === 'accepted') {
        void applyAcceptedChange(c).then((ok) => {
          if (!ok) {
            // The edit couldn't be placed: its `before` anchor is no longer in
            // the note (the user edited that region after the proposal, or the
            // note otherwise changed). Cursor's rule — the user's text wins, so
            // DISMISS (keep their text) rather than reopen, which would just
            // re-fail on the same stale anchor in a loop. But SURFACE it: a
            // silently-vanished "Kept" reads as success when nothing was written
            // (the bug this audit flagged). The change stays 'accepted'
            // (resolved, drops from pending).
            notify.markCantApply()
            console.info('[applier] suggestion outdated — kept user text', c.id)
          }
          // Commit at accept time for BOTH sources — Keep is when the
          // disk actually changes. The coordinator debounces a burst of
          // Keeps from the same run/pass into a single commit. Chat used
          // to commit at turn end (finalizeEditCommit), but the propose_*
          // flow writes nothing until Keep, so that never fired and the
          // turn-end path was removed; this is now the only commit path.
          scheduleGroupCommit(c, ok)
        })
      } else if (c.status === 'rejected') {
        // Phase E6: both sources are pure store mutations now. Chat
        // proposals come from the `propose_*` MCP tools which return
        // immediately (no parked Promise to resolve), and the LLM
        // sees the "queued for review" success message regardless.
        // Reject = drop the entry from the apply queue; the disk
        // is never touched. Logged for diagnostics only.
        console.log('[applier] rejected', c.id, 'page', c.pageSlug, 'source', c.source)
        // If this proposal had created a brand-new empty note to host its body,
        // reject would otherwise orphan that empty note — clean it up.
        if (c.createdNewNote) cleanupRejectedNewNote(c)
      }
    }
  })
  console.log('[applier] started')
}

/** Stop listening. Test-only; production callers never invoke. */
export function stopPendingChangesApplier(): void {
  unsub?.()
  unsub = null
  orphanUnsub?.()
  orphanUnsub = null
  if (pruneTimer) clearInterval(pruneTimer)
  pruneTimer = null
  handledIds.clear()
  for (const t of groupTimers.values()) clearTimeout(t)
  groupTimers.clear()
  groupAccepts.clear()
  groupSourceLabel.clear()
}

// Vite HMR cleanup. When this module is replaced by a hot update,
// dispose the live subscription on the OUTGOING module instance so
// the incoming one's listener doesn't double up. Without this every
// dev save accumulates one stale subscriber per cycle (the bug that
// produced "4× duplicated wiki entries after a couple of saves").
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsub?.()
    unsub = null
    orphanUnsub?.()
    orphanUnsub = null
    if (pruneTimer) clearInterval(pruneTimer)
    pruneTimer = null
    handledIds.clear()
    for (const t of groupTimers.values()) clearTimeout(t)
    groupTimers.clear()
    groupAccepts.clear()
    groupSourceLabel.clear()
  })
}
