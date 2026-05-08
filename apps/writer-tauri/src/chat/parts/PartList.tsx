import type { MessagePart } from '@/chat/types'
import { PROPOSE_CHANGE_TOOL } from '@/chat/parts/proposeChangeTool'
import { StepStart } from '@/chat/parts/StepStart'
import { TextPart } from '@/chat/parts/TextPart'
import { ReasoningPart } from '@/chat/parts/ReasoningPart'
import { ToolPart } from '@/chat/parts/ToolPart'
import { ProposeChangePart } from '@/chat/parts/ProposeChangePart'

/** Walks an assistant turn's timeline. Each part type maps to its own
 * sub-component; unknown types fall through to a debug pill so coverage
 * gaps stay visible during development. */
export function PartList({
  parts,
  isStreaming,
}: {
  parts: MessagePart[]
  isStreaming: boolean
}) {
  return (
    <>
      {parts.map((part) => {
        switch (part.type) {
          case 'text':
            return <TextPart key={part.id} part={part} isStreaming={isStreaming} />
          case 'reasoning':
            return <ReasoningPart key={part.id} part={part} isStreaming={isStreaming} />
          case 'tool':
            // Built-in MCP tool: render with a domain-aware preview instead
            // of the generic JSON dump.
            if (part.toolName === PROPOSE_CHANGE_TOOL) {
              return <ProposeChangePart key={part.id} part={part} />
            }
            return <ToolPart key={part.id} part={part} />
          case 'step-start':
            return <StepStart key={part.id} />
        }
      })}
    </>
  )
}
