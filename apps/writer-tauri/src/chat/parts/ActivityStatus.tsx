import type { MessagePart, ToolPart } from '@/chat/types'
import { PROPOSE_CHANGE_TOOL } from '@/chat/parts/proposeChangeTool'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'

/** Top-of-turn activity indicator. Reads the parts timeline to pick a
 * natural-language label for what the model is currently doing —
 * "Thinking…" → "Suggesting an edit…" → "Reading the document…" — so the
 * user gets a human description of progress instead of a generic spinner.
 * Lives in a stable slot; only the label text changes on re-render. The
 * dot-matrix icon mirrors the one painted onto the doc's tab while a
 * run is in flight, so the user sees the same "AI is working" signal
 * in both surfaces. */
export function ActivityStatus({ parts }: { parts?: MessagePart[] }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <ChatRunningIcon size={12} className="shrink-0" />
      <span className="transition-opacity duration-150">{activityLabel(parts)}</span>
    </div>
  )
}

/** Pick the most descriptive label for the currently-active step. We walk
 * parts from newest to oldest and return the first unfinished tool's label;
 * fall back to "Thinking…" when the model is in reasoning or just started. */
export function activityLabel(parts: MessagePart[] | undefined): string {
  if (parts) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      if (p.type === 'tool' && (p.state === 'input-streaming' || p.state === 'input-available')) {
        return labelForTool(p)
      }
    }
  }
  return 'Thinking…'
}

function labelForTool(part: ToolPart): string {
  if (part.toolName === PROPOSE_CHANGE_TOOL) {
    const input = (part.input ?? {}) as { kind?: string }
    return input.kind === 'comment' ? 'Adding a comment…' : 'Suggesting an edit…'
  }
  // Friendly labels for the most common Claude built-in tools. Anything
  // we haven't named falls back to a generic "Using …" string.
  const map: Record<string, string> = {
    Read: 'Reading the document…',
    Edit: 'Editing the document…',
    Write: 'Writing…',
    Bash: 'Running a command…',
    Grep: 'Searching the document…',
    Glob: 'Looking up files…',
    WebSearch: 'Searching the web…',
    WebFetch: 'Fetching from the web…',
  }
  return map[part.toolName] ?? `Using ${part.toolName}…`
}
