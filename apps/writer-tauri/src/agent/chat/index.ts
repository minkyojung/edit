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
import { getActiveVaultPath } from '@/state/settingsStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { pathForDoc } from '@/lib/docPaths'
import { useChatRuns } from '@/stores/chatRuns'
import { useDocsStore } from '@/state/docsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useSkillProposalStore } from '@/state/skillProposalStore'
import {
  mapChatEditToPendingChange,
  materializeChatNewWikiPage,
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
import { resolveAgent } from '../agents'
import {
  buildUserContent,
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
    ],
    appendDocument = true,
    viewingFilePath,
    selectionText,
    vizEditTarget,
    permissionMode,
    autoAcceptEdits = false,
    builtinTools,
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
  // queue passes a generated article list), else the open doc's bodyMarkdown
  // cache — the editor-agnostic single source of truth, kept current on every
  // keystroke by the CM editor.
  const docText =
    pageContextMarkdown ??
    (slug ? useDocsStore.getState().handles[slug]?.bodyMarkdown : undefined) ??
    ''
  const docForPrompt = truncateDocForPrompt(docText)
  // Resolve this thread's agent (role) — the prompt body + memory
  // namespace come from here. Currently always the built-in default,
  // so behaviour is unchanged; the seam lets roles plug in later.
  const agent = resolveAgent(useThreadsStore.getState().threads[threadId]?.agentId)
  const systemBody = systemPrompt ?? agent.systemPrompt
  const prompt = promptOverride ?? buildUserContent(history ?? [], attachments)

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
  // resolve "this note" / "여기" deictically while staying free to act on other notes
  // via its tools. Null on the queue route or before the catalog hydrates.
  const knownDocs = useDocsStore.getState().knownDocs
  const currentDoc = slug ? knownDocs.find((d) => d.slug === slug) : undefined
  const currentFilePath = currentDoc
    ? pathForDoc(currentDoc, (s) => knownDocs.find((d) => d.slug === s))
    : null

  const system = composeSystemBlocks({
    docForPrompt,
    systemBody,
    ctx,
    // Ground the model's file tools in the real vault root (stable → cached prefix),
    // so the first Read doesn't guess a wrong absolute path.
    vaultRoot: getActiveVaultPath(),
    // Viewing a non-markdown file (PDF/image/…) → there's no doc body to
    // pin, and `view` may still hold the previously-open note's text, so
    // suppress the DOCUMENT block to avoid feeding stale, wrong context.
    // The VIEWING FILE block tells the model to Read the file instead.
    appendDocument: viewingFilePath ? false : appendDocument,
    currentFilePath,
    viewingFilePath,
    selectionText,
    vizEditTarget,
    today: todayLocalDate(),
  })
  // A viz-edit run gets the edit_visualization relay tool on top of whatever
  // the caller asked for. Skipped in plan mode (read-only — the gate would
  // deny it anyway).
  const effectiveRelayTools =
    vizEditTarget && permissionMode !== 'plan'
      ? [...relayTools, 'edit_visualization']
      : relayTools
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
      // No commit at turn end. Chat edits write NOTHING to disk during
      // the turn — the propose_* tools only stage proposals — so there's
      // nothing to record here. The commit happens when the user Keeps a
      // change: pendingChangesApplier observes the accept, writes disk,
      // and lands one `ai-edit: chat reply` commit per burst (the same
      // group-commit coordinator ingest uses).
    }
    const settleErr = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    Promise.all([
      listen<ChatEvent>('claude:event', (e) => {
        if (e.payload.runId !== runId) return
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
        const payload = {
          runId: e.payload.runId,
          pendingId: e.payload.pendingId,
          toolName: e.payload.toolName,
          input: e.payload.input,
        }
        // Ensure the target daily exists before we snapshot the catalog. The
        // model routes inbox actions to `daily/<date>.md`; in a headless run
        // that daily may not be in the catalog yet, so the path wouldn't
        // resolve and we'd materialize a phantom note. openDaily is
        // find-or-create — after it, the real daily resolves and the edit
        // appends to it instead.
        const writePath = (e.payload.input as { file_path?: unknown }).file_path
        const dailyDate =
          typeof writePath === 'string'
            ? writePath.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1]
            : undefined
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
        if (mapped) {
          usePendingChangesStore.getState().push(mapped)
          // acceptEdits mode: apply immediately instead of parking for review.
          // The change is rendered (diff preview) and then auto-accepted, so the
          // applier writes it to disk without a manual Keep — same accept path
          // the Keep button drives, just triggered automatically. Undo still
          // flows through the editor (Cmd-Z → reopen).
          if (autoAcceptEdits) {
            usePendingChangesStore.getState().accept(mapped.id)
          }
          // A brand-new note isn't open in any editor, so cmProofReview never
          // mounts for it and the inline preview can't show. On interactive
          // runs, open it — the editor mounts, subscribes to the pending store,
          // and renders the staged body as a green preview. Existing-note edits
          // are left alone (the suggestion card's click-to-jump handles those;
          // auto-jumping on every edit would be intrusive).
          if (createdNewNote && navigateToNewNotes) {
            navigateToNoteBySlug(mapped.pageSlug)
          }
        } else {
          console.warn(
            '[chat] edit-pending unmappable; no decision surface',
            { toolName: e.payload.toolName, pendingId: e.payload.pendingId },
          )
        }
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
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        recordContextUsage(threadId, model, e.payload.usage, e.payload.contextUsage)
        // Reflect the SDK's actual fast-mode state (on / cooldown / off) for the
        // toggle. Absent → off (e.g. a model that doesn't support fast mode).
        useFastModeStore.getState().set(threadId, e.payload.fastModeState ?? 'off')
        settleOk(e.payload.stopReason)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
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
            // SDK reports `resetsAt` in seconds since epoch. The UI works in ms
            // (Date.now() math) so we normalize at the boundary.
            const resetsAtSec = payloadRl?.resetsAt ?? snapshotRl?.resetsAt
            ;(err as Error & { rateLimit?: ChatErrorRateLimit }).rateLimit = {
              resetsAt: typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : undefined,
              rateLimitType: payloadRl?.rateLimitType ?? snapshotRl?.rateLimitType,
              overageDisabledReason: payloadRl?.overageDisabledReason,
            }
          }
          settleErr(err)
        }
      }),
      // Sidecar process death. The Rust supervisor emits this on
      // child exit (before attempting restart). Without it, in-flight
      // runs hang waiting on chat:event / chat:done that will never
      // arrive — the producer is gone. We settle as a regular error
      // so the UI shows a retry card.
      listen<{ mode: string }>('sidecar:died', (e) => {
        if (e.payload.mode !== 'chat') return
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
        relayTools: effectiveRelayTools,
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
        effort,
        // Forwarded to the SDK's settings.fastMode. The caller already gated on
        // model support; only send `true` so non-fast runs stay clean.
        fastMode: fastMode || undefined,
        sessionId: isResume ? undefined : threadId,
        resume: isResume ? threadId : undefined,
      },
    })
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

