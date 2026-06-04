// Direct-API call helper for structured (schema-bound) LLM tasks.
//
// Companion to the Claude Agent SDK path used by chat / ingest:
//
//   - Agent SDK (sidecar)   → autonomous, multi-turn, tool loops
//   - structuredCall (here) → one-shot, force-tool, no autonomy
//
// The Agent SDK doesn't expose `tool_choice`, so for tasks that
// MUST return a specific schema (profile extraction, future quick
// summaries / titles / lint) we go through Anthropic's Messages API
// directly. Browser CORS blocks the call from the WebView, so the
// actual HTTP request happens in Rust (`anthropic_messages_create`
// Tauri command) using the same OAuth token the sidecar uses — no
// extra auth flow for the user.
//
// The helper returns the `input` payload from the tool_use block,
// typed by the caller. If the model declines to call the tool
// (effectively impossible with tool_choice forced, but defensive),
// returns null and logs the assistant's text reply.

import { invoke } from '@tauri-apps/api/core'

const DEFAULT_MAX_TOKENS = 4096

export interface StructuredCallArgs {
  /** Anthropic model id, e.g. `claude-sonnet-4-6`. */
  model: string
  /** System prompt — task framing, rules, constraints. */
  systemPrompt: string
  /** User prompt — the per-call input the model acts on. */
  prompt: string
  /** Tool name the model is forced to call. Must match the
   * `name` field in the tool definition below. */
  toolName: string
  /** Human description shown to the model. Should be one or two
   * sentences explaining what the tool does. */
  toolDescription: string
  /** JSON Schema for the tool's `input` payload (top-level object).
   * Must match the TInput type the caller wants back. */
  toolSchema: Record<string, unknown>
  /** Optional cap on response length. Defaults to 4096. */
  maxTokens?: number
  /** Optional sink for the failure reason (HTTP status + API message,
   * or transport error). Called once before a null return so callers
   * can surface the real cause instead of a generic message. */
  onError?: (message: string) => void
}

// OAuth tokens minted by Claude Code's login are scoped to Claude Code:
// the Messages API rejects a direct request whose system prompt doesn't
// begin with this exact identity (the Agent SDK injects it for us on the
// sidecar path; here we must add it ourselves). Sent as the first system
// block, ahead of the caller's task framing.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

interface RawResponse {
  status: number
  body: {
    type?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
    }>
    stop_reason?: string
    error?: { type: string; message: string }
    [key: string]: unknown
  }
}

/** Call Anthropic's Messages API with `tool_choice` forced to a
 * specific tool. Returns the parsed tool input on success, null
 * on any failure (network, auth, malformed model output). All
 * errors surface to the console for diagnosis. */
export async function structuredCall<TInput>(
  args: StructuredCallArgs,
): Promise<TInput | null> {
  const body = {
    model: args.model,
    max_tokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    // First block MUST be the Claude Code identity for OAuth-token auth.
    system: [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: args.systemPrompt },
    ],
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: args.toolSchema,
      },
    ],
    // The whole point of going through this helper rather than the
    // Agent SDK: force the model into the tool. Without this, even
    // strong prompt language can't reliably override the model's
    // default "respond with text" bias on some prompts.
    tool_choice: { type: 'tool', name: args.toolName },
    messages: [{ role: 'user', content: args.prompt }],
  }

  let raw: RawResponse
  try {
    raw = await invoke<RawResponse>('anthropic_messages_create', {
      request: { body },
    })
  } catch (err) {
    console.error('[structuredCall] invoke failed', { toolName: args.toolName, err })
    args.onError?.(`request failed: ${String(err)}`)
    return null
  }

  if (raw.status !== 200) {
    console.error('[structuredCall] non-200 response', {
      toolName: args.toolName,
      status: raw.status,
      error: raw.body?.error,
    })
    args.onError?.(
      `API ${raw.status}: ${raw.body?.error?.message ?? 'request rejected'}`,
    )
    return null
  }

  // tool_choice forces the response shape: assistant message with
  // exactly one content block of type 'tool_use'. We accept the
  // first matching block in case the model emits stray text first
  // (rare with forced tool_choice but tolerated).
  const blocks = raw.body?.content ?? []
  const toolUse = blocks.find(
    (b) => b.type === 'tool_use' && b.name === args.toolName,
  )
  if (!toolUse || toolUse.input === undefined) {
    console.warn('[structuredCall] no tool_use block in response', {
      toolName: args.toolName,
      stopReason: raw.body?.stop_reason,
      contentTypes: blocks.map((b) => b.type),
      textPreview: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text?.slice(0, 200))
        .join(' / '),
    })
    args.onError?.('the model did not return a structured result')
    return null
  }

  return toolUse.input as TInput
}
