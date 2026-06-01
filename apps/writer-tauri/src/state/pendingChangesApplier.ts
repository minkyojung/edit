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
  appendToSystemLog,
} from '@/agent/applyIngest'
import { useGitStore } from './gitStore'
import { useDocsStore } from './docsStore'
import { useEditorViewStore } from './editorViewStore'
import { commitSuggestionInDoc } from '@/editor/markReconcile'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { flushDirty } from '@/lib/docFileSync'
import { pathForDoc } from '@/lib/docPaths'
import { todayLocalDate } from '@/hooks/useDocMeta'

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
  // Fast path — for edits materialised as suggestion marks in the
  // ACTIVE editor, commit them surgically in the doc (drop insert marks
  // → content becomes body; delete the delete-marked text). dirtyTracker
  // + flush then persist exactly what was on screen, cursor undisturbed
  // — no whole-doc replaceWith, no markdown re-match. The applier
  // subscribes before any editor mounts, so this runs before the inline-
  // review plugin's reconcile, which then finds no marks and no-ops.
  //
  // CRUCIAL: a single change can be MIXED — some edits materialise as
  // marks (committed here), others live only as decorations or were
  // unplaced (no marks). `commitSuggestionInDoc` reports which edit.ids
  // it handled; we markdown-apply ONLY the rest below. (Committing then
  // returning early would silently drop the non-materialised edits.)
  const view = useEditorViewStore.getState().view
  const committed =
    view && getActiveSlugFromHash() === change.pageSlug
      ? commitSuggestionInDoc(view.state, change.id)
      : null
  const handledEditIds = committed?.handledEditIds ?? new Set<string>()
  if (committed && view) {
    // The committed content is now ordinary body; dirtyTracker mirrors
    // it into handle.bodyMarkdown synchronously on dispatch, so the
    // markdown applies below see the updated body.
    view.dispatch(committed.tr)
  }

  let allOk = true
  for (const edit of change.edits) {
    // Already committed surgically in the doc — skip the markdown apply.
    if (handledEditIds.has(edit.id)) continue
    if (edit.kind === 'add') {
      if (!edit.after) {
        allOk = false
        continue
      }
      const ok = await appendMarkdownToWikiPage(change.pageSlug, edit.after)
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
        const ok = await applyWriteWikiPage(change.pageSlug, edit.after ?? '')
        if (!ok) allOk = false
        continue
      }
      const ok = await applyReplaceInWikiPage(
        change.pageSlug,
        edit.before,
        edit.after ?? '',
      )
      if (!ok) allOk = false
      continue
    }
    if (edit.kind === 'delete') {
      if (!edit.before) {
        allOk = false
        continue
      }
      const ok = await applyReplaceInWikiPage(change.pageSlug, edit.before, '')
      if (!ok) allOk = false
      continue
    }
    console.warn('[applier] unknown edit kind', edit.kind)
    allOk = false
  }
  return allOk
}

/** Auto-emit a single system:log row for an accepted change. Pulls
 * date / source / target / summary from data the host already has —
 * never asks the LLM to format anything. Keeps system:log a host-
 * managed surface (same shape as system:index).
 *
 * Skipped sources:
 *   - ingest: wikiHandoff emits one batched row per pass already
 *
 * Summary derivation precedence:
 *   1. entry.context.rationale (ingest-style — usually a one-liner)
 *   2. derived "edited (+N -M chars)" from the edit diff sizes
 *   3. last-resort "edited" placeholder
 *
 * Errors are swallowed (logged) — logging is best-effort; a failure
 * here should never block the actual apply that just succeeded. */
async function logAcceptedChange(change: PendingChange): Promise<void> {
  try {
    const knownDoc = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === change.pageSlug)
    if (!knownDoc) return
    const getDoc = (slug: string) =>
      useDocsStore.getState().knownDocs.find((d) => d.slug === slug)
    const sourcePath = pathForDoc(knownDoc, getDoc) ?? change.pageSlug

    let summary = change.context.rationale?.trim() ?? ''
    if (!summary) {
      let added = 0
      let removed = 0
      for (const e of change.edits) {
        added += e.after?.length ?? 0
        removed += e.before?.length ?? 0
      }
      summary =
        added > 0 || removed > 0
          ? `edited (+${added} -${removed} chars)`
          : 'edited'
    }

    await appendToSystemLog({
      date: todayLocalDate(),
      kind: change.source,
      source: sourcePath,
      summary,
    })
  } catch (err) {
    console.warn('[applier] auto-log failed', change.id, err)
  }
}

/** Group-level commit coordinator, shared by chat and ingest. As the
 * pending changes of a group (one chat run or one ingest pass, keyed by
 * groupId) are accepted, we collect them and, after a quiet debounce,
 * land them in a single `ai-edit: ...` commit. This keeps git history
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
  try {
    await flushDirty()
  } catch (err) {
    console.warn('[applier] flushDirty failed before commit', err)
  }
  const n = accepts.length
  const plural = n === 1 ? '' : 's'
  // Chat and ingest share this coordinator; only the subject differs.
  // Both keep the `ai-edit:` prefix so isAiEditCommit + the Review
  // panel's commitSource parser recognise them.
  const subject =
    accepts[0]?.change.source === 'chat'
      ? `ai-edit: chat reply (${n} page update${plural})`
      : `ai-edit: ingest from ${sourceLabel} (${n} page update${plural})`
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

  unsub = usePendingChangesStore.subscribe((state) => {
    for (const c of Object.values(state.byId)) {
      if (c.status === 'pending') continue
      if (handledIds.has(c.id)) continue
      handledIds.add(c.id)
      if (c.status === 'accepted') {
        void applyAcceptedChange(c).then((ok) => {
          // Auto-log every accepted chat change to system:log. system:log
          // is host-managed end-to-end — the LLM doesn't write to it.
          // Ingest pass logs are emitted by wikiHandoff in a single
          // batch row per pass, so we skip them here to avoid double
          // entries.
          if (ok && c.source === 'chat') {
            void logAcceptedChange(c)
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
