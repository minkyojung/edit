import type {
  MessagePart,
  ReasoningPart,
  ToolPart,
  TextPart as TextPartType,
} from '@/chat/types'
import { TextPart } from '@/chat/parts/TextPart'
import { ProcessChain } from '@/chat/parts/ProcessChain'

/** Walks an assistant turn's timeline and reshapes it for rendering.
 * All "process" parts (reasoning + tool calls) feed into a single
 * ProcessChain at the top of the turn — one outer collapsible whose
 * inner rows each have their own click-to-expand detail. Text parts
 * render in order below as the body. step-start parts are no-ops
 * (sidecar never emits them today; the schema reserves the slot). */
export function PartList({
  parts,
  isStreaming,
}: {
  parts: MessagePart[]
  isStreaming: boolean
}) {
  const processParts: Array<ReasoningPart | ToolPart> = []
  const textParts: TextPartType[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'reasoning':
      case 'tool':
        processParts.push(part)
        break
      case 'text':
        textParts.push(part)
        break
      case 'step-start':
        break
    }
  }

  return (
    <>
      {processParts.length > 0 && (
        <ProcessChain parts={processParts} isStreaming={isStreaming} />
      )}
      {textParts.map((part) => (
        <TextPart key={part.id} part={part} isStreaming={isStreaming} />
      ))}
    </>
  )
}
