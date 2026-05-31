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
import { FREE_CHAT_PROMPT } from '../skills/freeChat'
import { assembleContext } from '@/agent/contextPipeline'
import { getActiveVaultPath } from '@/state/settingsStore'
import { useChatRuns } from '@/stores/chatRuns'
import { useGitStore } from '@/state/gitStore'
import { useDocsStore } from '@/state/docsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import {
  mapChatEditToPendingChange,
  materializeChatNewWikiPage,
} from './toPendingChange'
import { flushDirty } from '@/lib/docFileSync'
import {
  agentIdForModel,
  DEFAULT_MODEL,
  type ChatErrorRateLimit,
  type ChatEvent,
  type DoneEvent,
  type ErrorEvent,
  type RunChatArgs,
  type RunChatResult,
  type ToolCallRecord,
} from './types'
import {
  buildUserPrompt,
  composeSystemBlocks,
  shouldResumeSession,
  truncateDocForPrompt,
} from './systemPrompt'
import { createStreamParser } from './streamParser'

export async function runChat(args: RunChatArgs): Promise<RunChatResult> {
  const {
    view,
    slug,
    threadId,
    history,
    prompt: promptOverride,
    systemPrompt,
    model = DEFAULT_MODEL,
    effort: effortOverride,
    relayTools = [
      'read_page',
      'search_wiki',
      // Path A: operational edits restored. `propose_edit` /
      // `propose_multi_edit` let the model state exactly what changes
      // (old_string → new_string), so the host applies a surgical
      // in-place edit instead of diffing a whole-body blob to *guess*
      // what changed. That guessing (Phase F's declarative-only model)
      // was the shared root of the misplaced-insert, stray-cursor, and
      // empty-panel bugs — the host can't reconstruct intent the model
      // never sent. The historical reason this was disabled — the
      // "couldn't find old_string" failure — is mitigated by the
      // tolerant matcher on the apply path (lib/looseMatch: exact →
      // normalized-line, so a benign bullet/spacing drift still
      // resolves). `propose_write` stays for brand-new pages and
      // explicit full rewrites only; the CLAUDE.md editing rules
      // already steer the model to Edit-first for existing files.
      'propose_edit',
      'propose_multi_edit',
      'propose_write',
    ],
    appendDocument = true,
    signal,
    onTextDelta,
    onThinkingDelta,
    onPart,
    sessionStarted,
  } = args
  // agentIdForModel was used to stamp marks; with marks gone the
  // value is now only kept for compatibility with any downstream
  // metadata field that still references it. We compute it lazily
  // so unused imports surface as lint failures if the binding
  // disappears entirely.
  void agentIdForModel

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
    .find((t) => t.role === 'user')
    ?.content?.trim()

  const docText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
  const docForPrompt = truncateDocForPrompt(docText)
  const systemBody = systemPrompt ?? FREE_CHAT_PROMPT
  const prompt = promptOverride ?? buildUserPrompt(history ?? [])

  // Chat mode — Karpathy / Claude Code shape: only the always-on
  // schema (CLAUDE.md + profile + conventions) lands in the system
  // prompt. The wiki catalog + page bodies that the legacy shape
  // injected up-front are intentionally absent here; the LLM uses
  // Read / Glob / Grep to fetch them on demand when a turn actually
  // warrants it. Failures upstream collapse to empty fields — chat
  // never blocks on the context round-trip.
  const ctx = await assembleContext({ mode: 'chat' })

  const system = composeSystemBlocks({
    docForPrompt,
    systemBody,
    ctx,
    appendDocument,
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

  const toolCalls: ToolCallRecord[] = []

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
    const settleOk = (stopReason: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      // Resolve the caller immediately; the per-turn commit runs
      // fire-and-forget so the chat UI doesn't wait on disk I/O.
      // The Review panel's 30 s background poll surfaces the new
      // commit shortly after; any user who opens the panel sooner
      // triggers a refresh on mount that catches it too.
      resolve({ stopReason, toolCalls })
      // Vault changes from this turn flow through the vaultWatcher
      // → noteActivity chain: Claude's built-in Edit/Write writes the
      // .md file → OS fsevent → watcher → dirtyPaths. When dirtyPaths
      // is non-empty at settle time, the turn produced disk changes
      // worth committing as one logical "ai-edit" entry. When it's
      // empty, the turn was pure conversation (question + answer)
      // and there's nothing to record.
      const hasDirtyPaths = useGitStore.getState().dirtyPaths.size > 0
      if (hasDirtyPaths) {
        void finalizeEditCommit(slug)
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
        if (e.payload.runId !== runId) return
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
        if (!mapped) {
          mapped = await materializeChatNewWikiPage(payload, ctx)
        }
        if (mapped) {
          usePendingChangesStore.getState().push(mapped)
        } else {
          console.warn(
            '[chat] edit-pending unmappable; no decision surface',
            { toolName: e.payload.toolName, pendingId: e.payload.pendingId },
          )
        }
      }),
      listen<DoneEvent>('claude:done', (e) => {
        if (e.payload.runId !== runId) return
        settleOk(e.payload.stopReason)
      }),
      listen<ErrorEvent>('claude:error', (e) => {
        if (e.payload.runId !== runId) return
        if (e.payload.code === 'CANCELLED') {
          settleErr(new DOMException(e.payload.message, 'AbortError'))
        } else {
          const err = new Error(`${e.payload.code}: ${e.payload.message}`)
          // For rate-limit failures, attach the most recent SDK
          // rate_limit snapshot so the renderer can drive a precise
          // countdown. The info travels as a non-enumerable
          // property to keep `Error` serialization predictable.
          const rateLimitInfo = parser.rateLimitInfo()
          if (e.payload.code === 'RATE_LIMIT' && rateLimitInfo) {
            // SDK reports `resetsAt` in seconds since epoch. The UI
            // side works in ms (Date.now() math) so we normalize at
            // the boundary.
            const resetsAtSec = rateLimitInfo.resetsAt
            ;(err as Error & { rateLimit?: ChatErrorRateLimit }).rateLimit = {
              resetsAt: typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : undefined,
              rateLimitType: rateLimitInfo.rateLimitType,
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
        relayTools,
        // Phase E6: explicit least-privilege builtin set. Write-side
        // built-ins (Edit / Write / MultiEdit / NotebookEdit) are
        // OMITTED — the LLM uses the host-applies `propose_*` MCP
        // tools (in `relayTools` above) for any disk-changing
        // intent. Sidecar's `canUseTool` gate is therefore dormant
        // for chat now; without write-side built-ins on the surface,
        // there's nothing for it to gate. Read-side / search / shell
        // remain since the model needs them to discover context.
        builtinTools: ['Read', 'Glob', 'Grep', 'Bash'],
        // Forwarded so sidecar's read_page / search_wiki handlers
        // can resolve vault-relative paths against the user's chosen
        // folder. Undefined when no vault selected — the sidecar
        // then skips registering filesystem tools (warns once).
        vaultPath: getActiveVaultPath() ?? undefined,
        effort,
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

/** Post-turn commit: flush any pending Y.Doc → disk writes the edits
 * touched, then land a single `ai-edit: chat reply (...)` commit so
 * the Review panel shows the turn as one card with rationale + diff.
 *
 * Fire-and-forget from settleOk; the caller already has its
 * RunChatResult and doesn't need to wait on git. A failure here
 * logs but doesn't surface — the commit message is best-effort and
 * the underlying disk state is already correct. */
async function finalizeEditCommit(slug: string): Promise<void> {
  try {
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === slug)
    const sourceLabel =
      known?.type === 'daily' && known.date
        ? `daily/${known.date}`
        : known?.title?.trim() || slug
    // Built-in Edit/Write writes straight to disk; we lean on the
    // vaultWatcher → dirtyPaths chain (kept in sync by Phase 2.1)
    // to know what to roll into this commit. The Review panel's
    // inline diff is the source of truth for what actually changed;
    // the commit subject is just a human-readable receipt.
    const dirtyCount = useGitStore.getState().dirtyPaths.size
    if (dirtyCount === 0) return
    await flushDirty()
    const fileWord = dirtyCount === 1 ? 'file' : 'files'
    const message = `ai-edit: chat reply (${dirtyCount} ${fileWord}, from ${sourceLabel})`
    await useGitStore.getState().commitChangesNow(message)
  } catch (err) {
    console.warn('[chat] post-turn commit failed', err)
  }
}
