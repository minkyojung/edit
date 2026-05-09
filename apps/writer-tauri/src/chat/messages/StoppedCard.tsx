import type React from 'react'
import { IconPlayerStopFilled } from '@tabler/icons-react'
import type { ChatTurn } from '@/chat/types'
import { InlineCard, InlineCardFooter } from '@/chat/ui/InlineCard'
import { CopyButton } from '@/chat/messages/CopyButton'
import { RegenerateButton } from '@/chat/messages/RegenerateButton'

/** Card wrapper for an assistant turn the user stopped mid-stream.
 * Shows whatever streamed before the stop, footed with a "Stopped"
 * label, optional duration, and the same copy / regenerate actions
 * the normal footer offers. */
export function StoppedCard({
  turn,
  body,
  hasText,
  durationLabel,
  onRegenerate,
}: {
  turn: ChatTurn
  body: React.ReactNode
  hasText: boolean
  durationLabel: string | null
  onRegenerate?: (turnId: string) => void
}) {
  // The card only renders when status === 'stopped', so streaming is
  // already settled — copy / regenerate availability collapses to the
  // simpler "do we have text" / "did the parent give us a handler".
  const canCopy = hasText
  const canRegenerate = !!onRegenerate
  return (
    <InlineCard>
      <div className="px-3 py-2">{body}</div>
      <InlineCardFooter>
        <IconPlayerStopFilled size={12} stroke={0} className="opacity-70" />
        <span>Stopped</span>
        {durationLabel && <span className="opacity-70">· {durationLabel}</span>}
        {canCopy && <CopyButton text={turn.content} />}
        {canRegenerate && <RegenerateButton onClick={() => onRegenerate!(turn.id)} />}
      </InlineCardFooter>
    </InlineCard>
  )
}
