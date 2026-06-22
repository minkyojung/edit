import { IconHelpCircle } from '@tabler/icons-react'
import type { ToolPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** Renders an AskUserQuestion tool part as an activity row — the same column
 * as every other row — instead of a separate synthetic "you answered" bubble.
 * The header previews the question; expanding shows the Q&A once answered (the
 * chosen answer is stamped onto `part.answer` at turn rotation, since the SDK
 * tool output only echoes the options, not the selection). While the question
 * is still open the actual choices live in the footer QuestionPanel, so the row
 * is just a collapsed marker until the user answers. */
export function QuestionActivity({ part }: { part: ToolPart }) {
  const input = (part.input ?? {}) as {
    questions?: Array<{ question?: string }>
  }
  const firstQuestion = input.questions?.[0]?.question ?? 'Asked a question'
  const answer = typeof part.answer === 'string' && part.answer.trim().length > 0 ? part.answer : null

  return (
    <ActivityRow
      icon={<IconHelpCircle size={14} />}
      label="Asked"
      preview={firstQuestion}
      detail={answer ? <div className="whitespace-pre-wrap">{answer}</div> : undefined}
      defaultOpen={!!answer}
    />
  )
}
