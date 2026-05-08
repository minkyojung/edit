import type { TextPart as TextPartType } from '@/chat/types'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'

export function TextPart({
  part,
  isStreaming,
}: {
  part: TextPartType
  isStreaming: boolean
}) {
  if (!part.text) return null
  return <StreamingMarkdown content={part.text} isStreaming={isStreaming} />
}
