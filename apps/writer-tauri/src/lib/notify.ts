// Single source of truth for user-facing toast copy. Every silent failure
// point in the app routes through one of these named methods, so copy edits
// happen in one place and call sites stay readable (no inline strings).

import { toast } from 'sonner'

type RetryOpts = { onRetry?: () => void }

function retryAction(onRetry: (() => void) | undefined, label = 'Retry') {
  return onRetry ? { label, onClick: onRetry } : undefined
}

export const notify = {
  // ── Mark actions ──────────────────────────────────────────────
  /** Accept failed: the suggestion's anchor is no longer in the doc. */
  markCantApply() {
    toast.error('This suggestion no longer applies', {
      description: 'The surrounding text has changed',
    })
  },
  /** Accept(insert) hit a not-yet-ready markdown parser. Transient. */
  markEditorNotReady() {
    toast.error("Editor isn't ready yet", {
      description: 'Try again in a moment',
    })
  },
  /** Accept(insert) parsed the proposal but got an empty doc back. */
  markCantRead() {
    toast.error("Couldn't read this suggestion", {
      description: 'The content seems empty',
    })
  },
  /** Reject failed: the mark's anchor is no longer in the doc. */
  markCantDismiss() {
    toast.error("Couldn't dismiss this suggestion", {
      description: 'The surrounding text has changed',
    })
  },
  /** MarkToolbar manual create failed (schema lookup or commit). */
  markCantAdd() {
    toast.error("Couldn't add the mark")
  },

  // ── Note CRUD ─────────────────────────────────────────────────
  cantCreateNote(opts: RetryOpts = {}) {
    toast.error("Couldn't create note", {
      action: retryAction(opts.onRetry),
    })
  },
  cantOpenJournal(opts: RetryOpts = {}) {
    toast.error("Couldn't open today's journal", {
      action: retryAction(opts.onRetry),
    })
  },
  cantDeleteNote(opts: RetryOpts = {}) {
    toast.error("Couldn't delete note", {
      action: retryAction(opts.onRetry),
    })
  },
  cantEmptyTrash(opts: RetryOpts = {}) {
    toast.error("Some notes couldn't be deleted", {
      action: retryAction(opts.onRetry),
    })
  },
  cantOpenNote(opts: RetryOpts = {}) {
    toast.error("Couldn't open this note", {
      action: retryAction(opts.onRetry),
    })
  },

  // ── Auth ──────────────────────────────────────────────────────
  claudeSessionExpired(opts: { onReconnect?: () => void } = {}) {
    toast.error('Claude session expired', {
      description: 'Sign in again to keep using AI',
      action: opts.onReconnect
        ? { label: 'Reconnect', onClick: opts.onReconnect }
        : undefined,
    })
  },
  claudeSignInFailed(opts: RetryOpts = {}) {
    toast.error("Couldn't sign in to Claude", {
      action: retryAction(opts.onRetry, 'Try again'),
    })
  },

  // ── Chat ──────────────────────────────────────────────────────
  threadLimitReached(opts: { onArchive?: () => void } = {}) {
    toast.warning("You're at the 5-thread limit", {
      description: 'Archive a thread to start a new one',
      action: opts.onArchive
        ? { label: 'Archive…', onClick: opts.onArchive }
        : undefined,
    })
  },

  // ── Wikilink ──────────────────────────────────────────────────
  wikilinkCreateFailed() {
    toast.error("Couldn't create link")
  },

  // ── External link ─────────────────────────────────────────────
  /** Cmd+click on a link couldn't reach the system browser. */
  linkOpenFailed() {
    toast.error("Couldn't open link")
  },

  // ── Wiki sync ─────────────────────────────────────────────────
  /** Manual sync finished. Branches on whether anything new was
   * filed so the copy matches what actually changed — generic
   * "Synced" alone leaves the user wondering whether their click
   * did anything when the daily was already up to date. */
  wikiSynced(args: { proposals: number }) {
    if (args.proposals > 0) {
      const noun = args.proposals === 1 ? 'update' : 'updates'
      toast.success(`Synced — ${args.proposals} new wiki ${noun}`)
    } else {
      toast.success('Synced — nothing new today')
    }
  },
  /** Manual sync threw. Surfaces the rare error path (auth toasts
   * have their own dedicated handler higher in the call chain;
   * this one covers everything else). */
  wikiSyncFailed() {
    toast.error('Sync failed', { description: 'See console for details' })
  },
}

// Dev-only console handle so smoke testing can fire each toast without
// having to recreate its real-world trigger conditions.
//   In DevTools:  window.notify.markCantApply()
if (import.meta.env.DEV) {
  ;(window as unknown as { notify: typeof notify }).notify = notify
}

