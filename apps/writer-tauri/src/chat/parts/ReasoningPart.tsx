import type { ReasoningPart as ReasoningPartType } from '@/chat/types'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning'

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
    <Reasoning isStreaming={streamingNoText} className="mb-2 text-xs">
      <ReasoningTrigger />
      <ReasoningContent>{content}</ReasoningContent>
    </Reasoning>
  )
}
