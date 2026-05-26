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

/** Per-change apply path. Returns true on success so the caller
 * (or future retry logic) can tell whether the disk write took.
 *
 * For now only ingest 'add' is implemented — chat sources arrive in
 * Phase E with `replace` / `delete` variants. */
async function applyAcceptedChange(change: PendingChange): Promise<boolean> {
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

  // Seed the handled set with anything already decided at startup
  // so the first subscribe call (which fires once on subscribe)
  // doesn't re-apply persisted-decided entries from prior sessions.
  for (const c of Object.values(usePendingChangesStore.getState().byId)) {
    if (c.status !== 'pending') handledIds.add(c.id)
  }

  unsub = usePendingChangesStore.subscribe((state) => {
    for (const c of Object.values(state.byId)) {
      if (c.status === 'pending') continue
      if (handledIds.has(c.id)) continue
      handledIds.add(c.id)
      if (c.status === 'accepted') {
        void applyAcceptedChange(c).then((ok) => {
          scheduleGroupCommit(c, ok)
        })
      } else if (c.status === 'rejected') {
        // Nothing to do on disk — just diagnostic.
        console.log('[applier] rejected', c.id, 'page', c.pageSlug)
      }
    }
  })
  console.log('[applier] started')
}

/** Stop listening. Test-only; production callers never invoke. */
export function stopPendingChangesApplier(): void {
  unsub?.()
  unsub = null
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
    handledIds.clear()
    for (const t of groupTimers.values()) clearTimeout(t)
    groupTimers.clear()
    groupAccepts.clear()
    groupSourceLabel.clear()
  })
}
