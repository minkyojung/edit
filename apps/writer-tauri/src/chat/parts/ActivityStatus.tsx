import type { MessagePart, ToolPart } from '@/chat/types'
import { ChatRunningIcon } from '@/components/icons/ChatRunningIcon'
import { humanizeToolCall } from '@/chat/humanizers'

/** Top-of-turn activity indicator. Reads the parts timeline to pick a
 * natural-language label for what the model is currently doing — pulled
 * from the per-tool humanizers so the line embeds actual arguments
 * ("Replace 'X' → 'Y'", "Read page.tsx") instead of a generic spinner
 * caption. Lives in a stable slot; only the label text changes on
 * re-render. The dot-matrix icon mirrors the one painted onto the doc's
 * tab while a run is in flight, so the user sees the same "AI is
 * working" signal in both surfaces. */
export function ActivityStatus({ parts }: { parts?: MessagePart[] }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <ChatRunningIcon size={12} className="shrink-0" />
      <span className="transition-opacity duration-150">{activityLabel(parts)}</span>
    </div>
  )
}

/** Pick the most descriptive label for the currently-active step. We walk
 * parts from newest to oldest and return the first unfinished tool's
 * humanized label; fall back to "Thinking…" when the model is in
 * reasoning or just started. The trailing ellipsis is added here (not in
 * the humanizer) since this surface conveys ongoing-ness; the same
 * humanizer is reused without ellipsis in ProposeChangePart / ToolPart
 * headers where the chevron / state badge carry that signal instead. */
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
  const { label } = humanizeToolCall(part.toolName, part.input)
  return `${label}…`
}
