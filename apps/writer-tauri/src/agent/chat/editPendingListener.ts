// One turn's `claude:edit-pending` traffic: what the model proposed, what the
// host did with it, and what the model is told happened.
//
// Lifted verbatim out of `runChat`'s listener in `./index.ts`. It was ~320 lines
// inside a `listen()` callback, which meant no symbol to import and therefore no
// test — `materializeRace.test.ts` says as much in its own header, about the
// per-path mutex below. Nothing here changed in the move; the net that proves
// that is `editPending.characterization.test.ts`, written first and untouched
// by it.
//
// The split is the same one `metadataWrite.ts` already made for the metadata
// tools: the listener registers and routes, this decides and answers.

import { invoke } from '@tauri-apps/api/core'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useDocsStore } from '@/state/docsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { applyWriteWikiPage } from '@/agent/applyIngest'
import { guardedWholeDocWrite } from '@/agent/chat/wholeDocGuard'
import { notify } from '@/lib/notify'
import {
  mapChatEditToPendingChange,
  materializeChatNewWikiPage,
  mergeEditIntoStagedBody,
  toVaultRelative,
} from './toPendingChange'
import { checkEditPlacement, describeRefusal } from './checkPlacement'
import { readDocBody } from '@/state/docsStore/docBody'
import { createTurnWrites, type TurnWrites } from './turnWrites'
import type { EditPendingEvent } from './types'

/** What this handler needs from the run it belongs to. Plain values — the
 * handler reads stores directly for everything that changes underneath it. */
export interface EditPendingDeps {
  /** Only events carrying this run's id are ours. */
  runId: string
  threadId: string
  /** Apply each proposal the instant it lands instead of parking it for review. */
  autoAcceptEdits: boolean
  /** Open a note this run CREATES, so its green preview is visible. */
  navigateToNewNotes: boolean
  /** The user message that triggered this run — the Review panel's "why". */
  triggeringRequest: string | undefined
}

export interface EditPendingHandler {
  /** Handle one event. Never rejects: a failure is contained per path (see the
   * try/catch below) and reported to the model through the ack. */
  handle(payload: EditPendingEvent): Promise<void>
  /** What this turn wrote to, and what each note held before it did. Only
   * auto-accept fills this — a staged proposal changes nothing on disk, so
   * there is no moment to catch. Empty on interactive runs by design. */
  writes: TurnWrites
}

export function createEditPendingHandler(deps: EditPendingDeps): EditPendingHandler {
  const { runId, threadId, autoAcceptEdits, navigateToNewNotes, triggeringRequest } = deps

  const writes = createTurnWrites()

  /** Record what a note holds in the moment before this turn writes over it.
   *
   * Called at each auto-accept write site and nowhere else. `readDocBody` is
   * the canonical reader — the mounted editor when there is one, the mirror
   * otherwise — so what is kept is the text the write is actually replacing,
   * not a stale copy from disk. A note that does not exist yet reads as `''`,
   * which is the right answer rather than a missing one. */
  const keepBefore = (slug: string) => writes.aboutToWrite(slug, () => readDocBody(slug))

  // Per-turn, per-path coordination for the "same not-yet-existing file, two+
  // tool calls in one turn" race: without this, two `claude:edit-pending`
  // events for one file_path each independently see no existing doc (their
  // knownDocs snapshot predates the other's note creation) and both
  // materialize a brand-new note — materializeRace.test.ts reproduces this in
  // isolation. Keyed by the same toVaultRelative normalization used
  // everywhere else. Only entries for a NEWLY MATERIALIZED note are recorded
  // (an edit that resolves to an already-existing doc isn't racing anything —
  // mapChatEditToPendingChange creates nothing). Scoped to this handler's
  // closure — garbage collected when the run's listeners are detached.
  const newNoteByPath = new Map<
    string,
    Promise<{ pageSlug: string; pendingId: string } | null>
  >()

  async function handle(payload_: EditPendingEvent): Promise<void> {
    if (payload_.runId !== runId) return
    // Audit instrumentation (read-only, safe to leave on): logs each
    // edit-pending event's arrival so a same-turn race on one file_path —
    // two events resolving `knownDocs` before either has registered the
    // other's note (materializeRace.test.ts reproduces this in isolation)
    // — shows up as two log lines with the same filePath close in time.
    console.log('[chat] edit-pending', {
      runId: payload_.runId,
      toolName: payload_.toolName,
      filePath: (payload_.input as { file_path?: unknown }).file_path,
      atMs: Date.now(),
    })
    const payload = {
      runId: payload_.runId,
      pendingId: payload_.pendingId,
      toolName: payload_.toolName,
      input: payload_.input,
    }

    const filePathRaw = (payload_.input as { file_path?: unknown }).file_path
    const vaultRelPath =
      typeof filePathRaw === 'string'
        ? toVaultRelative(filePathRaw, getActiveVaultPath())
        : null

    // Promise-chain mutex, keyed by vault-relative path: this event
    // awaits whatever the PREVIOUS event for the same path is doing
    // (create or merge) before starting its own work, and immediately
    // publishes its own tail for the NEXT event to wait on. This
    // serializes any number of same-turn, same-path tool calls instead of
    // letting them race (materializeRace.test.ts reproduces the race
    // this closes). A path with no prior claim resolves instantly.
    const priorTail: Promise<{ pageSlug: string; pendingId: string } | null> =
      (vaultRelPath && newNoteByPath.get(vaultRelPath)) || Promise.resolve(null)

    // Whether THIS specific tool call's proposal was successfully queued
    // into pendingChangesStore ("Meaning A" — queued & valid — NOT
    // "Meaning B" — user approved & on disk, which stays fully async and
    // must never gate the sidecar's ack). Sent back to the sidecar below
    // so its PostToolUse hook can stop telling the model "queued" when it
    // silently wasn't (the eager-success gap the pipeline audit found).
    let ackOk = false
    // When a whole-doc write is refused as stale, the reason (with the
    // latest body inline) rides the ack back to the round-trip propose_write
    // tool, which returns it to the model as an error so it rebases.
    let ackReason: string | undefined
    // True ONLY when auto-accept mode actually wrote this change to disk (an
    // `accept()` that landed). Rides the ack back so the sidecar tells the
    // model "applied immediately" instead of "queued for review" — otherwise
    // the model, believing its edit is still pending, wrongly tells the user
    // to "reject the card" (there is none; it's already saved). Stays false on
    // interactive runs, where the change genuinely IS queued.
    let ackApplied = false

    const myTail = (async (): Promise<{ pageSlug: string; pendingId: string } | null> => {
      // The whole body is wrapped in try/catch: without this, a throw
      // anywhere below (materialize, disk write, ...) would reject this
      // promise, and since it's exactly what's stored in `newNoteByPath`,
      // EVERY later same-path event this turn would re-throw the same
      // rejection at `await priorTail` and silently no-op forever — a
      // worse failure than the race this mutex was built to close. On
      // catch, log and resolve to null so later same-path events fall
      // through to independent handling instead of being poisoned.
      try {
        const prior = await priorTail
        if (prior) {
          // A previous tool call THIS turn already materialized a new
          // note for this path — merge this call's edit into its staged
          // body instead of independently mapping/materializing (which
          // is what created the duplicate note before this fix).
          const current = usePendingChangesStore.getState().byId[prior.pendingId]
          if (!current) {
            console.warn(
              '[chat] edit-pending merge: pendingId missing from store',
              prior.pendingId,
            )
            return prior
          }
          if (current.status === 'rejected') {
            // The user (or an earlier failure) already declined this
            // note — don't resurrect it with a late write.
            return prior
          }
          const currentAfter = current.edits[0]?.after ?? ''
          const { text: mergedBody, placement } = mergeEditIntoStagedBody(
            currentAfter,
            payload_.toolName,
            payload_.input,
          )
          if (placement.kind === 'noop') {
            // Nothing left to do — typically this call repeats what the
            // PREVIOUS call this turn already staged. Report success: a
            // refusal here would have the model re-propose an edit that is
            // already in the staged body, forever.
            ackOk = true
            return prior
          }
          if (placement.kind !== 'ok') {
            // The tool's edit didn't land against the staged body — surface
            // it (A2's principle: don't silently no-op) AND tell the model
            // why, in the same words the first edit of the turn would get.
            notify.markCantApply()
            ackReason = describeRefusal(
              placement,
              typeof filePathRaw === 'string' ? filePathRaw : prior.pageSlug,
              currentAfter,
              current.edits.length,
            )
            return prior
          }
          if (current.status === 'pending') {
            // Still awaiting a decision — update the staged proposal.
            usePendingChangesStore.getState().push({
              ...current,
              edits: [{ ...current.edits[0], after: mergedBody }],
            })
            // Queued successfully — true regardless of what the
            // auto-accept write below does (that's Meaning B).
            ackOk = true
            if (autoAcceptEdits) {
              keepBefore(prior.pageSlug)
              const ok = await applyWriteWikiPage(
                prior.pageSlug,
                mergedBody,
                prior.pendingId,
              )
              if (ok) {
                usePendingChangesStore.getState().accept(prior.pendingId, mergedBody)
                ackApplied = true
              } else {
                // Don't call accept() on a failed write — that would
                // tell every surface "done" over content that never
                // reached disk. Leave the change pending so the user can
                // still Keep it manually after the toast.
                notify.autoAcceptWriteFailed()
              }
            }
          } else {
            // status === 'accepted': the store's push/accept would
            // silently no-op here (its "already decided" guard) — this is
            // exactly how this merge branch used to lose a second call's
            // content while auto-accept had already settled the first.
            // Write directly and check the result instead of assuming success.
            // Content was successfully incorporated (merged) either way —
            // true regardless of the disk-write outcome, same Meaning-A
            // reasoning as the `pending` branch above.
            ackOk = true
            keepBefore(prior.pageSlug)
            const ok = await applyWriteWikiPage(
              prior.pageSlug,
              mergedBody,
              prior.pendingId,
            )
            if (!ok) notify.autoAcceptWriteFailed()
            else ackApplied = true
          }
          // Don't navigate again — the first call already opened the note.
          return prior
        }

        // No prior claim on this path this turn — handle it exactly as
        // before this fix.
        //
        // Ensure the target daily exists before we snapshot the catalog. The
        // model routes inbox actions to `daily/<date>.md`; in a headless run
        // that daily may not be in the catalog yet, so the path wouldn't
        // resolve and we'd materialize a phantom note. openDaily is
        // find-or-create — after it, the real daily resolves and the edit
        // appends to it instead.
        const dailyDate = filePathRaw?.toString().match(
          /(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.md$/,
        )?.[1]
        if (dailyDate) {
          await useDocsStore.getState().openDaily(dailyDate)
        }
        const ctx = {
          knownDocs: useDocsStore.getState().knownDocs,
          vaultPath: getActiveVaultPath(),
          threadId,
          userRequest: triggeringRequest,
        }
        // First the pure mapper (existing doc). If it can't resolve a
        // catalog slug, the one recoverable miss is a `propose_write`
        // creating a brand-new wiki page: materialize the page (so it
        // gets a slug) and stage its body. Anything still unmapped is a
        // genuine miss — logged, no decision surface.
        let mapped = mapChatEditToPendingChange(payload, ctx)
        let createdNewNote = false
        if (!mapped) {
          mapped = await materializeChatNewWikiPage(payload, ctx)
          createdNewNote = !!mapped
        }
        if (!mapped) {
          console.warn(
            '[chat] edit-pending unmappable; no decision surface',
            { toolName: payload_.toolName, pendingId: payload_.pendingId },
          )
          return null
        }

        // Does this actually fit the document? Until now an unplaceable
        // proposal was pushed anyway: the chat card rendered, the editor
        // drew nothing (cmInBufferReview returns early on empty hunks), and
        // the model was told "queued". Check BEFORE pushing so there is no
        // card to leave stranded, and hand the reason to the model instead.
        // Fails open — see checkEditPlacement.
        //
        // Skipped for a note we just created: its body is whatever this
        // proposal stages, so there is no prior text an anchor could miss —
        // and a refusal here would abandon the freshly created file as an
        // empty orphan.
        const fit = createdNewNote
          ? ({ ok: true } as const)
          : await checkEditPlacement(
              mapped.pageSlug,
              mapped,
              typeof filePathRaw === 'string' ? filePathRaw : mapped.pageSlug,
            )
        if (!fit.ok) {
          ackReason = fit.reason
          return null
        }

        usePendingChangesStore.getState().push(mapped)
        // Queued successfully — true regardless of what the auto-accept
        // write below does (that's Meaning B, fully async by design).
        ackOk = true
        // acceptEdits mode: apply immediately instead of parking for review.
        // The change is rendered (diff preview) and then auto-accepted, so the
        // applier writes it to disk without a manual Keep — same accept path
        // the Keep button drives, just triggered automatically. Undo still
        // flows through the editor (Cmd-Z → reopen).
        if (autoAcceptEdits) {
          if (payload_.toolName === 'Write') {
            // Whole-doc overwrite — guard it with CAS (writeWholeDocGuarded)
            // so a stale write (the user edited the note while the model
            // generated) is refused and fed back to the model instead of
            // clobbering. Runs synchronously here, BEFORE the ack below that
            // the round-trip propose_write tool blocks on. For a brand-new
            // note this also writes the body into the handle before we open
            // it (the note is populated before the editor mounts — the race
            // the createdNewNote path used to guard by hand); accept with the
            // body as resolvedResult so the applier's own write is an
            // idempotent no-op.
            const body = mapped.edits.map((ed) => ed.after ?? '').join('\n\n')
            const filePath = String(payload_.input?.file_path ?? mapped.pageSlug)
            keepBefore(mapped.pageSlug)
            const outcome = await guardedWholeDocWrite(
              threadId,
              mapped.pageSlug,
              body,
              mapped.id,
              filePath,
            )
            if (outcome.kind === 'applied') {
              usePendingChangesStore.getState().accept(mapped.id, body)
              ackApplied = true
            } else if (outcome.kind === 'stale') {
              // Bounce the divergence back to the model (via the ack) so it
              // rebases; leave the change pending so the user's edit survives.
              ackOk = false
              ackReason = outcome.ackReason
            } else {
              // 'parked' (retries exhausted) or 'failed' — leave the change
              // pending for a manual Keep and say so. ackOk stays true so the
              // turn ends rather than looping.
              notify.autoAcceptWriteFailed()
            }
          } else {
            // Range edit (Edit/MultiEdit): the applier's live-CM write path
            // is already protected by updateDocBody's live read — no CAS.
            // Still a disk write during the turn, so the prior text is caught
            // here too — accept() is where it stops being reachable.
            keepBefore(mapped.pageSlug)
            usePendingChangesStore.getState().accept(mapped.id)
            ackApplied = true
          }
        }
        // Open the new note. In acceptEdits mode it's already populated
        // (above); on interactive runs the editor mounts, subscribes to the
        // pending store, and renders the staged body as a green preview.
        // Existing-note edits are left alone (the suggestion card's
        // click-to-jump handles those; auto-jumping on every edit is intrusive).
        if (createdNewNote && navigateToNewNotes) {
          navigateToNoteBySlug(mapped.pageSlug)
        }
        // Only claim this path for coordination when a note was ACTUALLY
        // newly materialized — an edit that resolved to an already-existing
        // doc isn't racing anything (nothing was created), so a later
        // same-path event should handle itself independently rather than
        // merging into an unrelated existing-doc PendingChange.
        return createdNewNote ? { pageSlug: mapped.pageSlug, pendingId: mapped.id } : null
      } catch (err) {
        console.error('[chat] edit-pending handler failed', {
          toolName: payload_.toolName,
          filePath: filePathRaw,
          err,
        })
        return null
      }
    })()

    if (vaultRelPath) newNoteByPath.set(vaultRelPath, myTail)
    await myTail

    // Tell the sidecar whether THIS call's proposal actually landed — the
    // propose_* tool handler is BLOCKED awaiting this pendingId (not
    // `mapped.id` in the merge case: the handler waits on what ITS OWN
    // tool call minted, which is always `payload_.pendingId`). Its
    // verdict becomes the tool result the model sees, which is what stops
    // it from re-proposing an edit it can't otherwise confirm landed.
    // Best-effort: the handler races a fail-open timeout, so a failure
    // here costs a lost confirmation and a delay, not a stuck turn.
    invoke('claude_chat_edit_ack', {
      args: { pendingId: payload_.pendingId, ok: ackOk, reason: ackReason, applied: ackApplied },
    }).catch((err) => {
      console.warn('[chat] edit-ack send failed', err)
    })
  }

  return { handle, writes }
}
