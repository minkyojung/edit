// Single source of truth for user-facing toast copy. Every silent failure
// point in the app routes through one of these named methods, so copy edits
// happen in one place and call sites stay readable (no inline strings).

import { toast } from 'sonner'
import type { SaveFailureCause } from '@/state/saveFailureStore'

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
  /** Auto-accept mode wrote a note's staged body to disk and the write
   * itself failed (disk error, permission) — surfaced immediately since
   * there's no manual Keep step to catch it later. */
  autoAcceptWriteFailed() {
    toast.error("Couldn't save the AI's change", {
      description: 'The file may be locked or unwritable',
    })
  },
  /** Auto-save has failed for ~1.5 s straight (persistent, not a blip):
   * the vault is unreachable / full / read-only. Copy names the real
   * cause and the real-world fix — this is NOT a "click save" prompt (the
   * app auto-saves; the user can't save manually). A single stable toast
   * id collapses the N-slugs-failing-at-once case into one toast; the
   * docFileSync reconciler updates its copy as the cause changes and
   * dismisses it via `saveFailedResolved` when writes recover.
   *
   * `dismissible: false` — the user must not be able to swipe away a live
   * "your edits aren't saving" warning and then keep typing into a void.
   * It clears only when the condition actually resolves (reconciler). */
  saveFailed(cause: SaveFailureCause, opts?: RetryOpts) {
    const copy: Record<SaveFailureCause, { title: string; description: string }> = {
      unreachable: {
        title: "Can't reach your vault folder",
        description: 'The drive may be disconnected. Recent changes are not saved yet.',
      },
      'disk-full': {
        title: 'Not enough disk space to save',
        description: 'Free up some space, then your changes will save automatically.',
      },
      permission: {
        title: "Can't save — permission denied",
        description: 'Check the folder permissions. Recent changes are not saved yet.',
      },
      unknown: {
        title: "Couldn't save your changes",
        description: 'If this keeps happening, please restart the app.',
      },
    }
    const c = copy[cause]
    toast.error(c.title, {
      id: 'save-failure',
      description: c.description,
      duration: Infinity,
      dismissible: false,
      action: retryAction(opts?.onRetry),
    })
  },
  /** Writes recovered — clear the persistent save-failure toast. */
  saveFailedResolved() {
    toast.dismiss('save-failure')
  },
  /** Keep/Reject clicked on a suggestion that was ALREADY decided a split
   * second earlier on another surface (the review tray, or the in-buffer
   * editor) — a narrow render-lag race, not a fault. Distinct copy from
   * `markCantApply`/`markCantDismiss`, which are about a STALE ANCHOR (the
   * surrounding text changed) — a different cause with a different fix
   * (re-propose vs. nothing to do here, it's already handled). Neutral
   * (not `.error`) since nothing actually went wrong. */
  alreadyHandled() {
    toast('Already handled', {
      description: 'This suggestion was accepted or rejected elsewhere a moment ago',
    })
  },
  /** Boot-time sweep found pending suggestions whose target text no longer
   * exists in the note — the file changed (external edit, sync) while the
   * app was closed. Dropped as a batch (one toast, not one per suggestion)
   * instead of leaving them to fail later at Keep time. */
  staleProposalsDropped(count: number) {
    toast(`${count} suggestion${count === 1 ? '' : 's'} removed`, {
      description: 'Their target text changed while the app was closed',
    })
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

  // ── Editor ────────────────────────────────────────────────────
  /** Milkdown's Editor.make().create() chain rejected. The doc loaded
   * but the editor couldn't be constructed — usually a schema/plugin
   * registration regression. Reopening the note re-runs the chain. */
  editorInitFailed() {
    toast.error('Editor failed to load', {
      description: 'Try closing and reopening this note',
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

  // ── External-edit conflict ────────────────────────────────────
  /** Vault watcher detected an external write to a doc that still
   * has unsaved local edits. Persistent toast (no auto-dismiss) with
   * two explicit resolutions — auto-flush stays gated on the conflict
   * store until the user picks one. VSCode 's save-conflict prompt
   * uses the same shape. */
  externalEditConflict(args: {
    fileName: string
    onReopen: () => void
    onDismiss: () => void
  }) {
    toast.warning(`External edit: ${args.fileName}`, {
      description: 'You have unsaved changes.',
      duration: Infinity,
      action: {
        label: 'Reload from disk',
        onClick: args.onReopen,
      },
      cancel: {
        label: 'Keep mine',
        onClick: args.onDismiss,
      },
    })
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
  /** Idle auto-organize filed inbox captures into the wiki and MOVED them to
   * their folders. The move is applied without a review card, so this toast is
   * how it surfaces — it lists what moved (short filename → folder). A longer
   * duration than a normal toast since the pass can fire while the user is away;
   * the moved notes are also visible (and reversible) in the file tree. */
  inboxOrganized(moves: { from: string; to: string }[]) {
    if (moves.length === 0) return
    const fileName = (p: string) => p.split('/').pop()?.replace(/\.md$/, '') ?? p
    const folderOf = (p: string) => {
      const i = p.lastIndexOf('/')
      return i >= 0 ? p.slice(0, i) : ''
    }
    const shown = moves.slice(0, 3).map((m) => `${fileName(m.from)} → ${folderOf(m.to)}/`)
    const more = moves.length > 3 ? ` +${moves.length - 3} more` : ''
    const noun = moves.length === 1 ? 'note' : 'notes'
    toast.success(`Organized ${moves.length} inbox ${noun}`, {
      description: shown.join(', ') + more,
      duration: 12000,
    })
  },
  /** Manual sync threw. Surfaces the rare error path (auth toasts
   * have their own dedicated handler higher in the call chain;
   * this one covers everything else). */
  wikiSyncFailed() {
    toast.error('Sync failed', { description: 'See console for details' })
  },

  // ── Chat → wiki handoff ───────────────────────────────────────
  /** User filed an assistant reply into the wiki and the engine
   * landed N proposals on the review queue. */
  chatHandoffQueued(args: { count: number }) {
    const noun = args.count === 1 ? 'update' : 'updates'
    toast.success(`Filed to wiki — ${args.count} new ${noun}`, {
      description: 'Open the wiki page to review',
    })
  },
  /** Engine ran cleanly but the model judged the message had no
   * durable facts to file. Not an error — surfacing it so the
   * click doesn't feel like a no-op. */
  chatHandoffEmpty() {
    toast.message('Nothing to file', {
      description: 'Nothing durable in this reply',
    })
  },
  /** Model emitted text but didn't call the structured tool. Soft
   * warning — caller can retry. */
  chatHandoffMalformed() {
    toast.warning("Couldn't read the wiki update", {
      description: 'The model response was malformed — try again',
    })
  },
  /** Transport / SDK error during chat→wiki handoff. */
  chatHandoffFailed() {
    toast.error("Couldn't file to wiki", {
      description: 'See console for details',
    })
  },

  // ── Vault ─────────────────────────────────────────────────────
  /** User picked a folder that isn't empty and isn't an existing
   * Writer vault. Vaults are "one folder = one app" so dropping our
   * structure into ~/Documents would pollute their personal files. */
  vaultFolderNotAcceptable(folderPath: string) {
    toast.error('That folder is not empty', {
      description: `${folderPath} has files we don't recognise. Pick an empty folder or an existing Writer vault.`,
    })
  },

  // ── Bootstrap profile ─────────────────────────────────────────
  /** Final summary toast for the first-run Profile pipeline (URL →
   * extractProfile → wiki:profile). Mirrors bootstrapImportComplete
   * but for the URL flow; fires after the dialog closes so the
   * user sees the outcome alongside the wiki:profile page that
   * just opened. */
  profileBootstrapComplete(args: {
    sourcesProcessed: number
    sourcesFailed: number
    saved: boolean
  }) {
    const { sourcesProcessed, sourcesFailed, saved } = args
    const sourceWord = (n: number) => (n === 1 ? 'source' : 'sources')
    if (!saved) {
      toast.error("Couldn't save your profile", {
        description: 'Profile extraction finished but writing the page failed. See console.',
      })
      return
    }
    if (sourcesProcessed === 0 && sourcesFailed > 0) {
      toast.error("Couldn't read any URLs", {
        description: `${sourcesFailed} ${sourceWord(sourcesFailed)} failed. See console for details.`,
      })
      return
    }
    if (sourcesFailed > 0) {
      toast.warning(`Profile created from ${sourcesProcessed} of ${sourcesProcessed + sourcesFailed} ${sourceWord(sourcesProcessed + sourcesFailed)}`, {
        description: `${sourcesFailed} ${sourceWord(sourcesFailed)} couldn't be read. See console.`,
      })
      return
    }
    toast.success(`Profile created from ${sourcesProcessed} ${sourceWord(sourcesProcessed)}`, {
      description: 'Open the Profile page to review — chat already sees it.',
    })
  },

  // ── Git ───────────────────────────────────────────────────────
  /** Auto-commit failed. Rare — usually a `git` binary missing or
   * a permission issue. Surfaced as a toast so the user knows the
   * "rollback safety net" isn't working; the editor itself keeps
   * functioning. */
  gitCommitFailed() {
    toast.error("Couldn't save to history", {
      description: 'Recent changes are still on disk. See console for details.',
    })
  },
  /** User clicked revert on an activity card and the rust call
   * threw. Most common cause: the revert produced conflicts that
   * git couldn't resolve unattended. */
  gitRevertFailed() {
    toast.error("Couldn't undo that change", {
      description: 'See console for details.',
    })
  },
  /** Revert went through cleanly. Surfacing it so the click feels
   * confirmed; the editor will reflect the rollback once the
   * vault watcher picks up the file changes. */
  gitRevertSucceeded() {
    toast.success('Reverted')
  },
  /** "Mark all reviewed" failed. Almost never happens — it's just
   * a ref-update — but surface it so the activity feed not
   * clearing has a visible reason. */
  gitMarkReviewedFailed() {
    toast.error("Couldn't update the bookmark", {
      description: 'See console for details.',
    })
  },

  // ── Read it later ─────────────────────────────────────────────
  /** A URL was saved as an article doc. */
  articleSaved(args: { title: string }) {
    toast.success('Saved to Read Later', {
      description: args.title,
    })
  },
  /** extractPage returned nothing usable for the given URL (404,
   * login wall, JS-only page, or empty extraction). */
  articleSaveFailed() {
    toast.error("Couldn't save this page", {
      description: "We couldn't read its content. Check the URL.",
    })
  },

  // ── Bootstrap import ──────────────────────────────────────────
  /** Final summary toast for the first-run Import pipeline. Without
   * it the dialog just closes silently — user has no way to tell
   * whether anything was extracted, especially when the LLM returns
   * 0 proposals (which is a valid outcome, not an error). Picker
   * cancel is handled separately (caller bounces back to Stage 1)
   * so this never fires for "nothing happened at all". */
  bootstrapImportComplete(args: {
    filesProcessed: number
    filesFailed: number
    totalProposals: number
  }) {
    const { filesProcessed, filesFailed, totalProposals } = args
    const succeeded = filesProcessed - filesFailed
    const filesWord = (n: number) => (n === 1 ? 'file' : 'files')
    const entriesWord = (n: number) => (n === 1 ? 'entry' : 'entries')

    if (succeeded === 0 && filesFailed > 0) {
      toast.error("Couldn't import any files", {
        description: `${filesFailed} ${filesWord(filesFailed)} failed. See console for details.`,
      })
      return
    }
    if (filesFailed > 0) {
      toast.warning(`Imported ${succeeded} of ${filesProcessed} files`, {
        description: `${filesFailed} ${filesWord(filesFailed)} couldn't be read. See console.`,
      })
      return
    }
    if (totalProposals > 0) {
      toast.success(`Imported ${succeeded} ${filesWord(succeeded)}`, {
        description: `${totalProposals} new wiki ${entriesWord(totalProposals)} ready to review`,
      })
      return
    }
    toast.success(`Imported ${succeeded} ${filesWord(succeeded)}`, {
      description: 'No new facts to extract',
    })
  },

  // ── Attachments ───────────────────────────────────────────────
  attachmentTooLarge(name: string) {
    toast.error(`${name} is too large`, {
      description: 'Maximum file size is 20 MB',
    })
  },
  attachmentLimitReached() {
    toast.error('Maximum 5 files per message', {
      description: 'Remove an attachment to add another',
    })
  },
}

// Dev-only console handle so smoke testing can fire each toast without
// having to recreate its real-world trigger conditions.
//   In DevTools:  window.notify.markCantApply()
if (import.meta.env.DEV) {
  ;(window as unknown as { notify: typeof notify }).notify = notify
}

