// Streaming chat runner entry point — drives a single chat turn
// through the Tauri sidecar. The sidecar wraps Anthropic's Agent
// SDK (`query()`), which internally handles tool execution; we
// only consume the resulting notifications:
//
//   claude:event → assistant text blocks (accumulated, emitted
//                  as deltas)
//   claude:done  → end of turn
//   claude:error → upstream failure or cancellation
//
// File edits used to flow through a `claude:edit` notification from
// the host-bridged `edit_document` MCP tool, but that bridge was
// retired alongside Phase 3.1's `canUseTool` gate — Claude now uses
// its built-in Edit/Write tools directly. The host's role here
// is just to commit the resulting on-disk changes at turn end
// (via the vaultWatcher → noteActivity → dirtyPaths chain).
//
// V1 multi-turn handling: only the latest user message is sent;
// session resumption (via the SDK's `resume` option) keeps prior
// turns server-side.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { assembleContext } from '@/agent/contextPipeline'
import {
  getActiveVaultPath,
  getDefaultNoteFolder,
  getKnowledgeBaseFolder,
  getSandboxEnabled,
  getPersistentQueryEnabled,
} from '@/state/settingsStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { pathForDoc } from '@/lib/docPaths'
import { useChatRuns } from '@/stores/chatRuns'
import { useDocsStore } from '@/state/docsStore'
import { readDocBody } from '@/state/docsStore/docBody'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useGitStore, aiEditSubject } from '@/state/gitStore'
import { applyWriteWikiPage } from '@/agent/applyIngest'
import { useSkillProposalStore } from '@/state/skillProposalStore'
import { notify } from '@/lib/notify'
import {
  mapChatEditToPendingChange,
  materializeChatNewWikiPage,
  mergeEditIntoStagedBody,
  toVaultRelative,
} from './toPendingChange'
import { useContextUsageStore } from '@/state/contextUsageStore'
import { useThreadsStore } from '@/state/threadsStore'
import { useFastModeStore } from '@/state/fastModeStore'
import { contextLimitForModel } from '@/lib/contextLimit'
import type { ContextSnapshot } from '@/chat/types'
import {
  DEFAULT_MODEL,
  type ChatErrorRateLimit,
  type ChatEvent,
  type DoneEvent,
  type ErrorEvent,
  type RunChatArgs,
  type RunChatResult,
} from './types'
import { parseChatEvent, parseDoneEvent, parseErrorEvent } from './eventSchemas'
import { resolveAgent } from '../agents'
import { buildEditOutcomeNote } from './buildEditOutcomeNote'
import {
  buildUserPrompt,
  composeSystemBlocks,
  shouldResumeSession,
  truncateDocForPrompt,
} from './systemPrompt'
import { createStreamParser } from './streamParser'

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    pageContextMarkdown,
    slug,
    threadId,
    history,
    prompt: promptOverride,
    systemPrompt,
    model = DEFAULT_MODEL,
    effort: effortOverride,
    relayTools = [
      // Path A: operational edits. `propose_edit` lets the model state exactly
      // what changes (old_string → new_string), so the host applies a surgical
      // in-place edit instead of diffing a whole-body blob to *guess* what
      // changed. The historical "couldn't find old_string" failure is mitigated
      // by the tolerant matcher on the apply path (lib/looseMatch). `propose_write`
      // stays for brand-new pages and explicit full rewrites only.
      //
      // `propose_multi_edit` was dropped: the in-buffer review now renders several
      // pending proposals at once, so N separate `propose_edit` calls give the same
      // "many edits to one file" outcome — each individually reviewable — without a
      // third tool the model has to choose between.
      'propose_edit',
      'propose_write',
      'propose_skill',
      // File-and-forget: when the agent organizes, it moves a note OUT of the
      // capture folder into its resting place. Auto-applied (reversible), not
      // queued — see the claude:move-note handler below.
      'move_note',
    ],
    appendDocument = true,
    viewingFilePath,
    selectionText,
    mentionPaths,
    permissionMode,
    autoAcceptEdits = false,
    builtinTools,
    allowDelegation,
    fastMode,
    attachments,
    signal,
    onTextDelta,
    onThinkingDelta,
    onPart,
    onSessionStart,
    sessionStarted,
    navigateToNewNotes = false,
  } = args

  // Effort default: Haiku is the copyeditor lane (short, latency-
  // sensitive turns) → 'low'. Sonnet/Opus are the chat lane → 'medium'.
  // Caller's explicit choice always wins.
  const effort: 'low' | 'medium' | 'high' | 'xhigh' =
    effortOverride ?? (model.includes('haiku') ? 'low' : 'medium')

  // The user message that triggered this run — the last user turn in
  // history (which includes it, per RunChatArgs.history). Attached to
  // any pending edit this run proposes as its Review-panel "why".
  const triggeringRequest = [...(history ?? [])]
    .reverse()
    .find((t) => t.role === 'user' && !t.synthetic)
    ?.content?.trim()

  // "Current page" text: the caller-supplied page markdown (the Read Later
  // queue passes a generated article list), else the open doc's body via the
  // canonical reader — the live editor when one is mounted, so the model sees
  // what's on screen (not the mirror, which lags mid-edit).
  const docText = pageContextMarkdown ?? (slug ? readDocBody(slug) : '')
  const docForPrompt = truncateDocForPrompt(docText)
  // Resolve this thread's agent (role) — the prompt body + memory
  // namespace come from here. Currently always the built-in default,
  // so behaviour is unchanged; the seam lets roles plug in later.
  const agent = await resolveAgent(useThreadsStore.getState().threads[threadId]?.agentId)
  const systemBody = systemPrompt ?? agent.systemPrompt
  // Attachments now ride as vault paths (written to `.octave/attachments/` on attach),
  // injected as an orientation block the model Reads on demand — same channel
  // as @-mentions. No base64 in the prompt.
  const attachedFiles = (attachments ?? []).map((a) => a.path)
  // Attachment-only sends carry no text, but an empty user message is invalid —
  // fall back to a minimal instruction so the ATTACHED FILES block has a turn to
  // act on. Harmless for the normal path (buildUserPrompt is non-empty there).
  const derivedPrompt = buildUserPrompt(history ?? [])
  const basePrompt =
    promptOverride ??
    (derivedPrompt || (attachedFiles.length > 0 ? 'Look at the attached file(s).' : derivedPrompt))

  // Correct the model's record for edits it proposed on a PRIOR turn that
  // never landed (user rejected, or the accept failed on a stale anchor).
  // The sidecar told it "success" immediately (so the run didn't stall), so
  // without this it keeps believing those edits are in the files. Skip on
  // special flows (Regenerate / bootstrap) that pass an explicit prompt.
  // `outcomeIds` is stamped delivered only after the run actually starts,
  // so a failed start doesn't silently consume the outcomes.
  const outcome = promptOverride ? { note: null, ids: [] } : buildEditOutcomeNote(threadId)
  const prompt = outcome.note ? `${outcome.note}\n\n${basePrompt}` : basePrompt

  // Chat mode — Karpathy / Claude Code shape: only the always-on
  // schema (CLAUDE.md + profile) lands in the system prompt. The wiki
  // catalog + page bodies that the legacy shape injected up-front are
  // intentionally absent here; the LLM uses Read / Glob / Grep to fetch
  // them on demand when a turn actually warrants it. Durable facts the
  // user wants remembered land in the wiki (profile / entity pages) via
  // the proposal flow — there's no separate always-on memory surface.
  // Failures upstream collapse to empty fields — chat never blocks on
  // the context round-trip.
  const ctx = await assembleContext()

  // The note the user is currently viewing, as a vault-relative path — orientation
  // context (Cursor's "attached current file"), NOT a hard constraint. Lets the model
  // resolve "this note" / "here" deictically while staying free to act on other notes
  // via its tools. Null on the queue route or before the catalog hydrates.
  const knownDocs = useDocsStore.getState().knownDocs
  const currentDoc = slug ? knownDocs.find((d) => d.slug === slug) : undefined
  const currentFilePath = currentDoc
    ? pathForDoc(currentDoc, (s) => knownDocs.find((d) => d.slug === s))
    : null

  // @-mentioned files. Resolve each path back to its doc so we can inject the
  // in-memory body when the note is open/loaded (fresher than disk — the
  // editor flushes lazily, so a just-edited note reads empty off disk). Unloaded
  // notes fall back to a "Read this path" instruction.
  const handles = useDocsStore.getState().handles
  const mentionFiles = (mentionPaths ?? []).map((path) => {
    const doc = knownDocs.find(
      (d) => pathForDoc(d, (s) => knownDocs.find((x) => x.slug === s)) === path,
    )
    const body = doc ? handles[doc.slug]?.bodyMarkdown : undefined
    return { path, body: body && body.trim() ? body : undefined }
  })

  const system = composeSystemBlocks({
    docForPrompt,
    systemBody,
    ctx,
    // Ground the model's file tools in the real vault root (stable → cached prefix),
    // so the first Read doesn't guess a wrong absolute path.
    vaultRoot: getActiveVaultPath(),
    // Name the configured capture folder so the model treats it as a staging
    // inbox to route notes OUT of (rename-safe — reads the setting).
    captureFolder: getDefaultNoteFolder(),
    // Name the configured knowledge-base folder so the model files durable
    // synthesized knowledge there (authoritative over the CLAUDE.md schema).
    knowledgeBaseFolder: getKnowledgeBaseFolder(),
    // Viewing a non-markdown file (PDF/image/…) → there's no doc body to
    // pin, and `view` may still hold the previously-open note's text, so
    // suppress the DOCUMENT block to avoid feeding stale, wrong context.
    // The VIEWING FILE block tells the model to Read the file instead.
    appendDocument: viewingFilePath ? false : appendDocument,
    currentFilePath,
    viewingFilePath,
    selectionText,
    mentionFiles,
    attachedFiles,
    today: todayLocalDate(),
  })
  const runId = crypto.randomUUID()

  // Internal controller is the single source of abort — it bridges the
  // (optional) caller-supplied signal AND the central chatRuns registry,
  // so an abort from either side fans out the same way.
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const runs = useChatRuns.getState()
  runs.start(threadId, runId, controller, slug)

  // Live stream → MessagePart translator. Owns the timeline state
  // (partsById, blockIndexToPartId, etc.) so this file only sees
  // the entry points it actually drives.
  const parser = createStreamParser({ onPart, onTextDelta, onThinkingDelta })

  const unlistens: UnlistenFn[] = []

  // Per-turn, per-path coordination for the "same not-yet-existing file, two+
  // tool calls in one turn" race: without this, two `claude:edit-pending`
  // events for one file_path each independently see no existing doc (their
  // knownDocs snapshot predates the other's note creation) and both
  // materialize a brand-new note — materializeRace.test.ts reproduces this in
  // isolation. Keyed by the same toVaultRelative normalization used
  // everywhere else. Only entries for a NEWLY MATERIALIZED note are recorded
  // (an edit that resolves to an already-existing doc isn't racing anything —
  // mapChatEditToPendingChange creates nothing). Scoped to this run's
  // closure — garbage collected when the run's promise settles, same
  // lifetime as `unlistens` below; no explicit teardown needed.
  const newNoteByPath = new Map<
    string,
    Promise<{ pageSlug: string; pendingId: string } | null>
  >()

  const cleanup = () => {
    useChatRuns.getState().end(runId)
    while (unlistens.length > 0) {
      const u = unlistens.pop()
      try {
        u?.()
      } catch {
        // listeners are best-effort; an already-detached one is fine
      }
    }
  }

  const finished = new Promise<RunChatResult>((resolve, reject) => {
    let settled = false
    // Latches the once-per-run session-start signal (first claude:event).
    let sessionEventSeen = false
    const settleOk = (stopReason: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      // Derive the edit count from the single source of truth — the
      // PendingChanges this run pushed (keyed by runId). By settle
      // (claude:done) every edit-pending event for the turn has been
      // mapped and pushed; the review-comments path only edits existing
      // docs (synchronous mapper, no async materialize), so the count is
      // complete here. No tray/return-value tally is maintained.
      const editCount = Object.values(
        usePendingChangesStore.getState().byId,
      ).filter((c) => c.context.runId === runId).length
      resolve({ stopReason, editCount })
      // Reviewed edits write NOTHING to disk during the turn (propose_* only
      // stage; the commit lands when the user Keeps, via the applier's group
      // commit). But move_note auto-applies DURING the turn and never passes
      // through that Keep→commit path. So checkpoint a turn that dirtied the
      // tree WITHOUT producing reviewable edits (editCount === 0) — i.e. a
      // pure auto-move turn. When editCount > 0 we leave it to the applier so
      // its `edit(ai): …` label wins (its `git add -A`
      // sweeps any same-turn moves too). Empty-safe + serialized.
      if (editCount === 0 && useGitStore.getState().dirtyPaths.size > 0) {
        void useGitStore.getState().commitChangesNow(aiEditSubject('organize'))
      }
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (!parseChatEvent(e.payload) || e.payload.runId !== runId) return
        // First event of any kind = the SDK has confirmed/created the session
        // for this thread (its `system` init lands before any content). Mark
        // session-started here so a turn that dies mid-think still flips the
        // resume flag — gating on the first content part (onPart) was too late
        // and let a duplicate-create slip through on the retry.
        if (!sessionEventSeen) {
          sessionEventSeen = true
          onSessionStart?.()
        }
        parser.handleEvent(e.payload.event)
      }),
      // Phase 3.3 staged-edit gate: the sidecar's canUseTool hook
      // parks the SDK on every write-side built-in (Edit / Write /
      // MultiEdit / NotebookEdit) and emits this event with a
      // sidecar-minted `pendingId`. The PendingEditsBar renders an
      // Apply / Reject card per event and routes the user's decision
      // back through `claude_chat_edit_decision` so the matching
      // canUseTool Promise resolves and the SDK either runs the
      // tool (allow) or feeds the deny message to the model.
      listen<{
        runId: string
        pendingId: string
        toolName: string
        input: Record<string, unknown>
      }>('claude:edit-pending', async (e) => {
        if (e.payload.runId !== runId) return
        // Phase E5: unified flow. Map the sidecar payload into a
        // PendingChange and push. The sidebar dot lights up, the
        // inline suggestion card in the chat answer renders the diff
        // with Keep / Reject, and the inline review widget renders the
        // diff on the target page. There is no separate tray —
        // `pendingChangesStore` is the single source of truth for chat
        // edits, and every surface reads it.
        // Audit instrumentation (read-only, safe to leave on): logs each
        // edit-pending event's arrival so a same-turn race on one file_path —
        // two events resolving `knownDocs` before either has registered the
        // other's note (materializeRace.test.ts reproduces this in isolation)
        // — shows up as two log lines with the same filePath close in time.
        console.log('[chat] edit-pending', {
          runId: e.payload.runId,
          toolName: e.payload.toolName,
          filePath: (e.payload.input as { file_path?: unknown }).file_path,
          atMs: Date.now(),
        })
        const payload = {
          runId: e.payload.runId,
          pendingId: e.payload.pendingId,
          toolName: e.payload.toolName,
          input: e.payload.input,
        }

        const filePathRaw = (e.payload.input as { file_path?: unknown }).file_path
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
              const mergedBody = mergeEditIntoStagedBody(
                currentAfter,
                e.payload.toolName,
                e.payload.input,
              )
              if (mergedBody === currentAfter) {
                // The tool's edit didn't land against the staged body (e.g.
                // an Edit whose old_string isn't there) — surface it (A2's
                // principle: don't silently no-op) instead of pretending it
                // merged.
                notify.markCantApply()
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
                  const ok = await applyWriteWikiPage(
                    prior.pageSlug,
                    mergedBody,
                    prior.pendingId,
                  )
                  if (ok) {
                    usePendingChangesStore.getState().accept(prior.pendingId, mergedBody)
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
                const ok = await applyWriteWikiPage(
                  prior.pageSlug,
                  mergedBody,
                  prior.pendingId,
                )
                if (!ok) notify.autoAcceptWriteFailed()
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
                { toolName: e.payload.toolName, pendingId: e.payload.pendingId },
              )
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
              if (createdNewNote) {
                // A brand-new note isn't open in any editor yet, so the async
                // applier would RACE the navigate-to-open below: if the editor
                // mounts before the applier's write lands, it reads an empty
                // buffer and the body never appears (the change is already
                // 'accepted', so the in-buffer review won't re-render it). Write
                // the body into the handle HERE and await it, so the note is
                // populated before we open it. Accept with the body as
                // resolvedResult so the applier's own write is an idempotent
                // whole-doc no-op (bodyMarkdown already matches) rather than a
                // second, doubling append.
                const body = mapped.edits.map((ed) => ed.after ?? '').join('\n\n')
                const ok = await applyWriteWikiPage(mapped.pageSlug, body, mapped.id)
                if (ok) {
                  usePendingChangesStore.getState().accept(mapped.id, body)
                } else {
                  // The note WAS materialized (it has a slug + catalog entry) —
                  // only the write failed. Leave it pending so the user can
                  // retry via a manual Keep, and say so immediately (no later
                  // checkpoint will catch this in auto-accept mode).
                  notify.autoAcceptWriteFailed()
                }
              } else {
                // Existing note: its editor is already mounted, so the applier's
                // live-CM write path updates the open buffer with no race.
                usePendingChangesStore.getState().accept(mapped.id)
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
              toolName: e.payload.toolName,
              filePath: filePathRaw,
              err,
            })
            return null
          }
        })()

        if (vaultRelPath) newNoteByPath.set(vaultRelPath, myTail)
        await myTail

        // Tell the sidecar whether THIS call's proposal actually landed —
        // its PostToolUse hook is waiting on this pendingId (not `mapped.id`
        // in the merge case: the hook is keyed to what ITS OWN tool call
        // returned, which always stamps `e.payload.pendingId`). Best-effort:
        // the hook fails open on its own timeout if this never arrives, so a
        // failure here is a lost confirmation, not a stuck turn.
        invoke('claude_chat_edit_ack', {
          args: { pendingId: e.payload.pendingId, ok: ackOk },
        }).catch((err) => {
          console.warn('[chat] edit-ack send failed', err)
        })
      }),
      // propose_skill tool fired (Phase 2B). The sidecar relays a proposed
      // reusable skill; we stage it in the dedicated skillProposalStore (NOT
      // pendingChangesStore — a skill isn't a wiki doc). The card renders
      // Keep/Reject; on Keep the store writes `_system/agent/skills/<name>/
      // SKILL.md`, picked up on the next session via the plugins path.
      listen<{
        runId: string
        pendingId: string
        name: string
        description: string
        body: string
        // Set when the model is revising an existing skill (the exact name
        // of the skill it updates); null for a brand-new skill.
        updates: string | null
      }>('claude:skill-pending', (e) => {
        if (e.payload.runId !== runId) return
        useSkillProposalStore.getState().push({
          pendingId: e.payload.pendingId,
          runId: e.payload.runId,
          name: e.payload.name,
          description: e.payload.description,
          body: e.payload.body,
          updates: e.payload.updates ?? null,
        })
      }),
      // move_note MCP tool: relocate a note out of the capture folder into its
      // resting place. Auto-applied (no review card) — a move is reversible and
      // loses no content. Resolve the note by its (vault-relative) path and hand
      // it to docsStore.moveDocToFolder, which rewrites relPath and lets the
      // flush machinery move the file on disk.
      listen<{ runId: string; fromPath: string; toFolder: string }>(
        'claude:move-note',
        (e) => {
          if (e.payload.runId !== runId) return
          const relFrom = toVaultRelative(e.payload.fromPath, getActiveVaultPath())
          if (!relFrom) {
            console.warn('[chat] move-note: unresolved path', e.payload.fromPath)
            return
          }
          const doc = useDocsStore
            .getState()
            .knownDocs.find((d) => d.relPath === relFrom)
          if (!doc) {
            console.warn('[chat] move-note: no note at', relFrom)
            return
          }
          // Strip any leading/trailing slashes so 'people/' and '/people' both
          // land as the folder 'people'. '' would target the vault root.
          const folder = e.payload.toFolder.replace(/^\/+|\/+$/g, '')
          const ok = useDocsStore.getState().moveDocToFolder(doc.slug, folder)
          console.log('[chat] move-note', { from: relFrom, toFolder: folder, ok })
        },
      ),
      listen<DoneEvent>('claude:done', (e) => {
        if (!parseDoneEvent(e.payload) || e.payload.runId !== runId) return
        recordContextUsage(threadId, model, e.payload.usage, e.payload.contextUsage)
        // Reflect the SDK's actual fast-mode state (on / cooldown / off) for the
        // toggle. Absent → off (e.g. a model that doesn't support fast mode).
        useFastModeStore.getState().set(threadId, e.payload.fastModeState ?? 'off')
        settleOk(e.payload.stopReason)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (!parseErrorEvent(e.payload) || e.payload.runId !== runId) return
        if (e.payload.code === 'CANCELLED') {
          settleErr(new DOMException(e.payload.message, 'AbortError'))
        } else {
          const err = new Error(`${e.payload.code}: ${e.payload.message}`)
          // Retryability decided by the sidecar from the structured error
          // code (absent → retryable). Drives whether ErrorCard shows Retry.
          ;(err as Error & { retryable?: boolean }).retryable = e.payload.retryable
          // For rate-limit failures, attach the SDK's reset info so the card
          // can show the right window + countdown. The sidecar now carries it on
          // the error payload (single source, observed from `rate_limit_event`);
          // fall back to the parser's most-recent snapshot. Travels as a
          // non-enumerable property to keep `Error` serialization predictable.
          const payloadRl = e.payload.rateLimit
          const snapshotRl = parser.rateLimitInfo()
          if (e.payload.code === 'RATE_LIMIT' && (payloadRl || snapshotRl)) {
            // SDK reports `resetsAt` in seconds since epoch (its type leaves the
            // unit undocumented); the UI works in ms (Date.now() math). Normalize
            // by magnitude so we're correct either way: a seconds value (~1.7e9)
            // is scaled ×1000, but an already-ms value (~1.7e12) is passed through
            // — a seconds epoch won't cross 1e12 until the year ~33658, so the
            // threshold cleanly separates the two.
            const resetsAtRaw = payloadRl?.resetsAt ?? snapshotRl?.resetsAt
            const resetsAt =
              typeof resetsAtRaw !== 'number'
                ? undefined
                : resetsAtRaw > 1e12
                  ? resetsAtRaw
                  : resetsAtRaw * 1000
            ;(err as Error & { rateLimit?: ChatErrorRateLimit }).rateLimit = {
              resetsAt,
              rateLimitType: payloadRl?.rateLimitType ?? snapshotRl?.rateLimitType,
              overageDisabledReason: payloadRl?.overageDisabledReason,
            }
          }
          settleErr(err)
        }
      }),
      // Sidecar process death. The Rust supervisor transitions the chat
      // sidecar to `restarting` (respawning) or `dead` (terminal) on child
      // exit. Without settling here, in-flight runs hang waiting on
      // claude:event / claude:done that will never arrive — the producer is
      // gone. We settle as a regular error so the UI shows a retry card.
      listen<{ status: string; mode: string }>('sidecar:state', (e) => {
        if (e.payload.mode !== 'chat') return
        if (e.payload.status !== 'restarting' && e.payload.status !== 'dead') return
        settleErr(new Error('SIDECAR_DIED: chat sidecar crashed'))
      }),
    ])
      .then((registered) => {
        unlistens.push(...registered)
      })
      .catch((err) => settleErr(err))

    if (controller.signal.aborted) {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      settleErr(new DOMException('aborted', 'AbortError'))
      return
    }
    controller.signal.addEventListener('abort', () => {
      invoke('claude_chat_cancel', { args: { runId } }).catch(() => {})
      // The CANCELLED chat:error notification will arrive and finalize.
    })
  })

  // Map our threadId 1:1 to the SDK's session UUID. First turn of a
  // thread creates the session via `sessionId`; later turns load it
  // via `resume`. Doing both at once is invalid (without forkSession)
  // so we pick exactly one based on whether an assistant has spoken
  // yet. Persisted server-side under ~/.claude/projects/ so the
  // session survives app restarts.
  const isResume = shouldResumeSession(history, sessionStarted)
  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model,
        systemPrompt: system,
        prompt,
        relayTools,
        // Read-only planning turns set this to 'plan'; edit turns omit it
        // (sidecar defaults to bypassPermissions). In plan mode the sidecar's
        // canUseTool gate — NOT tool omission — enforces read-only: the caller
        // still passes the full propose_* relayTools (so the model can execute
        // once the plan is approved), and the gate denies them while planning
        // and allows them after ExitPlanMode is approved. builtinTools drops
        // Bash but keeps Write (confined to the plans dir by the same gate).
        permissionMode,
        // Phase E6: explicit least-privilege builtin set. Write-side
        // built-ins (Edit / Write / MultiEdit / NotebookEdit) are
        // OMITTED — the LLM uses the host-applies `propose_*` MCP
        // tools (in `relayTools` above) for any disk-changing
        // intent. Read-side / search / shell remain since the model
        // needs them to discover context. WebSearch / WebFetch let
        // the model pull live information from the web (read-only, so
        // they run freely under bypassPermissions — no canUseTool
        // gate). Plan turns drop Bash via the caller-supplied
        // `builtinTools`.
        builtinTools:
          builtinTools ??
          [
            'Read',
            'Glob',
            'Grep',
            'Bash',
            'WebSearch',
            'WebFetch',
            'AskUserQuestion',
            'TodoWrite',
            'Task',
          ],
        // Forwarded so sidecar's read_page / search_wiki handlers
        // can resolve vault-relative paths against the user's chosen
        // folder. Undefined when no vault selected — the sidecar
        // then skips registering filesystem tools (warns once).
        vaultPath: getActiveVaultPath() ?? undefined,
        // Security lockdown (block network egress + secret reads). Forwarded
        // to the sidecar's `sandboxEnabled`; default ON, user-toggleable.
        sandboxEnabled: getSandboxEnabled(),
        // Whether this run may delegate (Task) / activate skills. Omitted for
        // chat/plan (sidecar defaults ON); intake passes false so its narrow
        // builtin set can't be widened back to include Task.
        allowDelegation,
        effort,
        // Forwarded to the SDK's settings.fastMode. The caller already gated on
        // model support; only send `true` so non-fast runs stay clean.
        fastMode: fastMode || undefined,
        sessionId: isResume ? undefined : threadId,
        resume: isResume ? threadId : undefined,
        // Persistent-query path. When on, the sidecar keeps one long-lived query
        // per thread so background subagent tasks survive across turns. threadId
        // is the conversation/session key; the sidecar manages resume internally
        // on the live query. A model / mode / fastMode change is reconciled on
        // the live query via control requests (setModel / setPermissionMode /
        // applyFlagSettings), so plan and model-switch turns stay on this path
        // too — no per-turn routing to the legacy path is needed.
        threadId,
        persistentQuery: getPersistentQueryEnabled() || undefined,
      },
    })
    // The run is underway with the outcome note in its prompt — stamp those
    // changes delivered so the same reject / failure isn't reported again.
    if (outcome.ids.length > 0) {
      usePendingChangesStore.getState().markFeedbackDelivered(outcome.ids)
    }
  } catch (e) {
    cleanup()
    throw e
  }

  return finished
}

/** Record the post-turn context-window occupancy for the gauge.
 *
 * STEP 2: the total is approximated from the SDK `usage` the sidecar
 * already emits on chat/done — the full prompt that was in context for
 * this turn = fresh input + cached prefix (read + creation). The window
 * size is the per-model estimate. STEP 3 replaces this with the exact
 * breakdown from query.getContextUsage(). Best-effort: a turn with no
 * usage (or zero tokens) leaves the prior snapshot untouched. */
function recordContextUsage(
  threadId: string,
  model: string,
  usage: DoneEvent['usage'],
  contextUsage?: DoneEvent['contextUsage'],
): void {
  const snapshot = buildContextSnapshot(model, usage, contextUsage)
  if (!snapshot) return
  useContextUsageStore.getState().set(threadId, snapshot)
  // Persist so the gauge survives an app restart — a resumed session keeps its
  // prior history, so an empty gauge would misrepresent how full the window is
  // until the next turn. Fire-and-forget; updateMeta no-ops if the thread was
  // dropped from the store mid-turn.
  void useThreadsStore.getState().updateMeta(threadId, { contextUsage: snapshot })
}

/** Build the post-turn context snapshot, or null when there's nothing to
 * record (no usage / zero tokens — leaves the prior snapshot untouched). */
function buildContextSnapshot(
  model: string,
  usage: DoneEvent['usage'],
  contextUsage?: DoneEvent['contextUsage'],
): ContextSnapshot | null {
  // STEP 3: prefer the exact per-category breakdown from getContextUsage().
  // It carries the authoritative window size and the auto-compact trigger,
  // so the gauge shows real category rows and aligns its warning line to the
  // point compaction actually fires (converted from tokens to a 0..1
  // fraction the gauge/popover compare against).
  if (contextUsage && contextUsage.maxTokens > 0) {
    return {
      totalTokens: contextUsage.totalTokens,
      maxTokens: contextUsage.maxTokens,
      model: contextUsage.model ?? model,
      categories: contextUsage.categories,
      autoCompactThreshold:
        contextUsage.autoCompactThreshold != null
          ? contextUsage.autoCompactThreshold / contextUsage.maxTokens
          : undefined,
      updatedAt: Date.now(),
    }
  }
  // Fallback (no contextUsage): approximate the total from `usage` and the
  // per-model window estimate.
  if (!usage) return null
  const total =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  if (total <= 0) return null
  return {
    totalTokens: total,
    maxTokens: contextLimitForModel(model),
    model,
    updatedAt: Date.now(),
  }
}

