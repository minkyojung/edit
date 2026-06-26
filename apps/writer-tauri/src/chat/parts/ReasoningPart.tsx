import { BrainIcon } from 'lucide-react'
import type { ReasoningPart as ReasoningPartType } from '@/chat/types'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'

/** Thinking-block renderer. Built on AI Elements `Reasoning` so the
 * collapsible primitive matches `Tool` / `ProposeChangePart` — same
 * chevron rotation, same fade/slide animation, same keyboard a11y. The
 * Reasoning container auto-opens during streaming and auto-closes ~1s
 * after the model stops thinking, replacing our previous hand-rolled
 * useState/useEffect dance, and surfaces a "Thought for N seconds"
 * duration when the run settles. */
export function ReasoningPart({
  part,
  isStreaming,
}: {
  part: ReasoningPartType
  isStreaming: boolean
}) {
  // Empty-state spinner is owned by the top-level ActivityStatus —
  // don't render until we actually have thoughts to show.
  if (!part.text) return null
  return <ThinkingPanel content={part.text} streamingNoText={isStreaming} />
}

/** Same as ReasoningPart but driven by a raw `thinking` string off the
 * legacy turn shape (turns produced before the parts timeline existed
 * carry their reasoning in `turn.thinking` rather than as a part). The
 * second prop name dates back to that legacy path. */
export function ThinkingPanel({
  content,
  streamingNoText,
}: {
  content: string
  streamingNoText: boolean
}) {
  return (
    <Reasoning isStreaming={streamingNoText} className="mb-2 text-footnote">
      <ReasoningTrigger />
      <ReasoningContent>{content}</ReasoningContent>
    </Reasoning>
  )
}

/** Collapsed-by-default "thinking pill": a dim one-line row (brain + label +
 * truncated preview of the reasoning) that expands to the full thinking text.
 * Unlike the streaming auto-open `Reasoning` default, this stays closed so the
 * model's reasoning never visually swamps the answer — liveliness during the
 * run is carried by the top-of-turn ActivityStatus line and the pill's own
 * shimmering label/preview instead. */
export function ThinkingPill({
  content,
  isStreaming,
}: {
  content: string
  isStreaming: boolean
}) {
  if (!content) return null
  return (
    <ActivityRow
      icon={<BrainIcon className="size-3.5" />}
      label={isStreaming ? <Shimmer duration={1}>Thinking…</Shimmer> : 'Thinking'}
      preview={previewLine(content)}
      detail={
        // Toned down vs the answer body — thinking is supporting context, not
        // the main read, so it sits dimmer even when expanded.
        <div className="opacity-70">
          <StreamingMarkdown content={content} isStreaming={false} />
        </div>
      }
    />
  )
}

/** First non-empty line of the reasoning, clamped — the pill's preview. */
function previewLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}
