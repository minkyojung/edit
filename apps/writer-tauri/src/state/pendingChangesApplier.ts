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

import { invoke } from '@tauri-apps/api/core'
import { usePendingChangesStore, type PendingChange } from './pendingChangesStore'
import { appendMarkdownToWikiPage } from '@/agent/applyIngest'
import { useGitStore } from './gitStore'
import { flushDirty } from '@/lib/docFileSync'

// HMR safety: vite's `import.meta.hot.dispose` fires right before
// the module is replaced. That's the only hook that runs against
// the OLD module instance (where `unsub` still holds the live
// zustand subscription). Cleaning up there is the recommended
// pattern — see Vite docs "HMR API" — and replaces the earlier
// globalThis attempt, which couldn't dispose listeners registered
// before the fix itself was written into the codebase.
let unsub: (() => void) | null = null
let pruneTimer: ReturnType<typeof setInterval> | null = null

/** How often the boot-time applier sweeps decided (accepted /
 * rejected) entries past their retention window. The store keeps
 * decided entries around briefly so the Review Panel can show
 * "just now" rows; without this sweep they accumulate forever
 * because `pruneDecided` was defined but never invoked. */
const PRUNE_INTERVAL_MS = 60_000

/** Send a chat edit decision back to the sidecar so the parked
 * `canUseTool` Promise resolves with the user's verdict. The sidecar
 * keyed its Promise on `pendingId`; we mint our PendingChange.id to
 * equal that pendingId so the lookup is just `change.id`. `runId`
 * lives on `context` because one chat thread can host many runs and
 * the sidecar needs both to route the verdict.
 *
 * Fire-and-forget — IPC errors are logged but don't surface, matching
 * the PendingEditsBar precedent. The worst case is the sidecar gate
 * stays parked, which the user can resolve by cancelling the run. */
async function sendChatEditDecision(
  change: PendingChange,
  decision: 'allow' | 'deny',
): Promise<boolean> {
  const runId = change.context.runId
  if (!runId) {
    console.warn(
      '[applier] chat change missing runId; cannot relay decision',
      change.id,
    )
    return false
  }
  try {
    await invoke('claude_chat_edit_decision', {
      args: { runId, pendingId: change.id, decision },
    })
    return true
  } catch (err) {
    console.warn('[applier] edit-decision relay failed', change.id, err)
    return false
  }
}

/** Per-change apply path. Returns true on success so the caller
 * (or future retry logic) can tell whether the work took.
 *
 *   - ingest: writes the edit to disk via `appendMarkdownToWikiPage`
 *   - chat:   relays the user's `allow` decision to the sidecar; the
 *             SDK then runs the Edit/Write tool itself and writes to
 *             disk. The applier never touches disk for chat changes
 *             — the SDK is still the writer, we just delayed when it
 *             gets to run. */
async function applyAcceptedChange(change: PendingChange): Promise<boolean> {
  if (change.source === 'chat') {
    return sendChatEditDecision(change, 'allow')
  }
  if (change.source !== 'ingest') {
    console.warn(
      '[applier] unknown source — no apply path yet',
      change.source,
    )
    return false
  }
  let allOk = true
  for (const edit of change.edits) {
    if (edit.kind !== 'add' || !edit.after) {
      console.warn(
        '[applier] unsupported edit kind for ingest source',
        edit.kind,
      )
      allOk = false
      continue
    }
    const ok = await appendMarkdownToWikiPage(change.pageSlug, edit.after)
    if (!ok) {
      console.error(
        '[applier] disk write failed for change',
        change.id,
        'page',
        change.pageSlug,
      )
      allOk = false
    }
  }
  return allOk
}

/** Group-level commit coordinator. When the LAST pending change of
 * a group is decided (accepted or rejected), we collect every
 * accepted entity from that group and land them in a single
 * `ai-edit: ingest from <source> (N page updates)` commit. This
 * keeps git history clean — one ingest pass = one commit, not one
 * commit per Accept click. */
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
  try {
    await flushDirty()
  } catch (err) {
    console.warn('[applier] flushDirty failed before commit', err)
  }
  const subject = `ai-edit: ingest from ${sourceLabel} (${accepts.length} page update${accepts.length === 1 ? '' : 's'})`
  try {
    await useGitStore.getState().commitChangesNow(subject)
  } catch (err) {
    console.warn('[applier] commit failed', err)
  }
}

/** Track which changes we've already applied so re-entrant store
 * notifications (e.g. zustand firing the listener after our own
 * status flip) don't double-write. */
const handledIds = new Set<string>()

/** Begin listening. Idempotent within a single module instance —
 * a second call is a no-op. HMR cleanup is handled by the
 * `import.meta.hot.dispose` block below; the next module instance
 * starts with a fresh `unsub === null`. */
export function startPendingChangesApplier(): void {
  if (unsub) return

  // Sweep stale chat entries left over from a prior process. Chat
  // changes are 1:1 with a sidecar canUseTool Promise that lives
  // only for the run that spawned it — when the app restarts that
  // Promise is gone, the SDK is gone, and there is no path that can
  // ever resolve the pending state again. Without this sweep the
  // store accumulates zombie entries across sessions: the sidebar
  // dot stays blue forever for pages that were edited mid-decide in
  // an earlier launch, and `pruneDecided` can't reach them because
  // they never reached `accepted` / `rejected`.
  //
  // Ingest entries are NOT swept — those survive restart by design
  // (the staged body is the only state the apply path needs; no
  // process-bound handle is involved).
  const store = usePendingChangesStore.getState()
  let zombies = 0
  for (const c of Object.values(store.byId)) {
    if (c.source === 'chat' && c.status === 'pending') {
      store.reject(c.id)
      // Mark as handled so the subscription's first-fire doesn't run
      // sendChatEditDecision('deny') against a gate that no longer
      // exists — that would be a wasted IPC at best, a console warn
      // at worst.
      handledIds.add(c.id)
      zombies += 1
    }
  }
  if (zombies > 0) {
    console.log(`[applier] swept ${zombies} stale chat entr${zombies === 1 ? 'y' : 'ies'} from prior session`)
  }

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

  unsub = usePendingChangesStore.subscribe((state) => {
    for (const c of Object.values(state.byId)) {
      if (c.status === 'pending') continue
      if (handledIds.has(c.id)) continue
      handledIds.add(c.id)
      if (c.status === 'accepted') {
        void applyAcceptedChange(c).then((ok) => {
          // Group-commit is an ingest-only concern: it batches accept
          // clicks into one `ai-edit: ingest ...` commit. Chat already
          // has its own finalizeEditCommit flow that fires on turn
          // end, so we skip the group path for chat changes — calling
          // it would either land an empty commit or double-commit.
          if (c.source === 'ingest') {
            scheduleGroupCommit(c, ok)
          }
        })
      } else if (c.status === 'rejected') {
        // Chat: tell the sidecar the user said no. Without this the
        // canUseTool Promise stays parked forever and the SDK can't
        // progress past the gated tool call. Ingest: nothing to do
        // — there's no disk write to undo and no parked Promise.
        if (c.source === 'chat') {
          void sendChatEditDecision(c, 'deny')
        } else {
          console.log('[applier] rejected', c.id, 'page', c.pageSlug)
        }
      }
    }
  })
  console.log('[applier] started')
}

/** Stop listening. Test-only; production callers never invoke. */
export function stopPendingChangesApplier(): void {
  unsub?.()
  unsub = null
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
    if (pruneTimer) clearInterval(pruneTimer)
    pruneTimer = null
    handledIds.clear()
    for (const t of groupTimers.values()) clearTimeout(t)
    groupTimers.clear()
    groupAccepts.clear()
    groupSourceLabel.clear()
  })
}
