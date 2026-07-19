// Per-tool humanizers — turn a (toolName, input, output) triple into a
// short, human-readable description that embeds the actual arguments
// instead of a generic "Using ToolName" string. Used by ActivityStatus,
// ProposeChangePart, and ToolPart to keep every chat surface consistent
// about what the agent is doing.
//
// Extension model: add a tool by registering one humanizer below. The
// fallback ensures unknown tools (e.g. a freshly added MCP tool) render
// safely as "Using <name>" until someone writes a real humanizer.
// Humanizers are pure functions of input/output so they're trivial to
// unit-test and reuse across surfaces.

import { EDIT_DOCUMENT_TOOL } from '@/chat/parts/proposeChangeTool'

export interface HumanizedToolCall {
  /** Single-line description to show as the activity / card header.
   * No trailing ellipsis — callers add one if the state warrants it. */
  label: string
  /** Optional inline chips (e.g. file references) the caller can render
   * alongside the label. Unset means "label is enough". */
  chips?: ChipSpec[]
}

export interface ChipSpec {
  kind: 'file'
  /** Display name — usually the basename of a path. */
  name: string
}

type Humanizer = (input: unknown, output?: unknown) => HumanizedToolCall

function truncate(s: string | undefined | null, max = 30): string {
  if (!s) return ''
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max).trimEnd() + '…'
}

function basename(path: string | undefined | null): string {
  if (!path) return ''
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

// Input may be partially-populated during input-streaming (the SDK
// delivers tool input as JSON deltas). Each humanizer falls back to a
// generic label when the fields it needs aren't present yet — the
// dynamic version takes over the moment the input parses cleanly.

function humanizeEditDocument(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as {
    quote?: string
    content?: string
    rationale?: string
  }
  if (!i.quote && !i.content) return { label: 'Editing the document' }
  const quote = truncate(i.quote, 28)
  const content = truncate(i.content, 28)
  if (!i.quote && i.content) return { label: `Inserting "${content}"` }
  if (i.quote && !i.content) return { label: `Deleting "${quote}"` }
  return { label: `Replace "${quote}" → "${content}"` }
}

/** Pull plain text out of a tool result — a raw string, or the SDK's
 * `[{type:'text', text}]` content-block array — so we can count lines or
 * render the read content. */
export function readOutputText(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const joined = output
      .map((b) =>
        b && typeof b === 'object' && 'text' in b
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
    return joined.length > 0 ? joined : null
  }
  return null
}

function countLines(output: unknown): number | null {
  const text = readOutputText(output)
  if (text == null) return null
  return text.replace(/\n+$/, '').split('\n').length
}

function humanizeRead(input: unknown, output?: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { file_path?: string }
  const name = basename(i.file_path)
  // The file name rides in the chip, so the label carries the line count
  // (once the result lands) rather than repeating the path.
  const lines = countLines(output)
  const label = lines != null ? `Read ${lines} lines` : name ? 'Read' : 'Reading'
  return name ? { label, chips: [{ kind: 'file', name }] } : { label }
}

function humanizeEdit(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { file_path?: string }
  const name = basename(i.file_path)
  if (!name) return { label: 'Editing' }
  return { label: 'Edit', chips: [{ kind: 'file', name }] }
}

function humanizeWrite(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { file_path?: string }
  const name = basename(i.file_path)
  if (!name) return { label: 'Writing' }
  return { label: 'Write', chips: [{ kind: 'file', name }] }
}

function humanizeGrep(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { pattern?: string; path?: string }
  if (!i.pattern) return { label: 'Searching' }
  const where = i.path ? ` in ${i.path}` : ''
  return { label: `Searching "${truncate(i.pattern, 40)}"${where}` }
}

function humanizeGlob(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { pattern?: string }
  if (!i.pattern) return { label: 'Looking up files' }
  return { label: `Finding files matching "${truncate(i.pattern, 40)}"` }
}

function humanizeBash(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { command?: string; description?: string }
  if (i.description) return { label: i.description }
  if (!i.command) return { label: 'Running a command' }
  return { label: `Run "${truncate(i.command, 40)}"` }
}

function humanizeWebSearch(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { query?: string }
  if (!i.query) return { label: 'Searching the web' }
  return { label: `Searching the web for "${truncate(i.query, 40)}"` }
}

function humanizeWebFetch(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { url?: string }
  if (!i.url) return { label: 'Fetching from the web' }
  let host = i.url
  try {
    host = new URL(i.url).hostname
  } catch {
    // Malformed URL during streaming — fall back to the raw string.
  }
  return { label: `Fetching ${host}` }
}

/** Our write-side MCP relay tools (propose_edit / write / multi_edit). The
 * model's intent is an edit proposal; the file rides in a chip and the label
 * is just the verb — keyed by short name (humanizeToolCall strips the
 * mcp__writer-relay__ prefix before lookup). Registering these stops the
 * fallback "Using propose_edit" string from leaking into the activity line. */
function humanizeProposeEdit(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { file_path?: string }
  const name = basename(i.file_path)
  return name ? { label: 'Edit', chips: [{ kind: 'file', name }] } : { label: 'Edit' }
}

function humanizeProposeWrite(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { file_path?: string }
  const name = basename(i.file_path)
  return name ? { label: 'Write', chips: [{ kind: 'file', name }] } : { label: 'Write' }
}

function humanizeAgent(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { description?: string }
  const d = i.description?.trim()
  return { label: d ? `Agent: ${truncate(d, 40)}` : 'Agent' }
}

function humanizeAskUserQuestion(input: unknown): HumanizedToolCall {
  const i = (input ?? {}) as { questions?: Array<{ question?: string }> }
  const q = i.questions?.[0]?.question
  return { label: q ? `Asked: ${truncate(q, 48)}` : 'Asked a question' }
}

const humanizers: Record<string, Humanizer> = {
  [EDIT_DOCUMENT_TOOL]: humanizeEditDocument,
  Agent: humanizeAgent,
  Task: humanizeAgent,
  AskUserQuestion: humanizeAskUserQuestion,
  propose_edit: humanizeProposeEdit,
  propose_write: humanizeProposeWrite,
  propose_multi_edit: humanizeProposeEdit,
  Read: humanizeRead,
  Edit: humanizeEdit,
  Write: humanizeWrite,
  Bash: humanizeBash,
  Grep: humanizeGrep,
  Glob: humanizeGlob,
  WebSearch: humanizeWebSearch,
  WebFetch: humanizeWebFetch,
}

/** Strip the SDK's MCP relay prefix off a tool name. Tools the sidecar
 * exposes via the MCP server arrive at the chat layer as
 * `mcp__<server>__<tool>` (e.g. `mcp__writer-relay__read_page`). The
 * humanizers map keys those tools by their short name (`read_page`),
 * so we peel the prefix before lookup — and also use the stripped
 * form as the fallback label so the user never sees the raw
 * relay-namespaced id. */
function stripMcpPrefix(toolName: string): string {
  const m = /^mcp__[\w-]+__(.+)$/.exec(toolName)
  return m ? m[1] : toolName
}

export function humanizeToolCall(
  toolName: string,
  input: unknown,
  output?: unknown,
): HumanizedToolCall {
  const direct = humanizers[toolName]
  if (direct) return direct(input, output)
  const short = stripMcpPrefix(toolName)
  const stripped = humanizers[short]
  if (stripped) return stripped(input, output)
  return { label: `Using ${short}` }
}
