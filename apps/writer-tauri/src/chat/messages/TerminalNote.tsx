import type { ReactNode } from 'react'
import { CopyButton } from '@/chat/messages/CopyButton'
import { RegenerateButton } from '@/chat/messages/RegenerateButton'

/** Borderless status line that closes out a turn which ended without a normal
 * answer. Sits directly under the (possibly empty) turn body as one quiet row.
 *
 * Deliberately NOT a boxed card — that chrome is reserved for real failures
 * (ErrorCard). This covers the two calmer tiers:
 *   - `tone="muted"` (grey): a benign ending the user caused or expected —
 *     Stop pressed mid-stream.
 *   - `tone="warning"` (amber): the turn settled but produced no usable answer
 *     — refused, cut off by the token limit, or empty. An anomaly worth a
 *     glance and usually a Regenerate, but not a system error.
 * Both share this lightweight line so the transcript stays calm and uniform. */
export function TerminalNote({
  tone = 'muted',
  icon,
  label,
  durationLabel,
  copyText,
  onRegenerate,
}: {
  tone?: 'muted' | 'warning'
  icon: ReactNode
  label: string
  durationLabel: string | null
  /** When set, a Copy action appears (copies this text). Omit to hide it. */
  copyText?: string
  /** When set, a Regenerate action appears. Omit to hide it. */
  onRegenerate?: () => void
}) {
  const toneClass = tone === 'warning' ? 'text-warning' : 'text-muted-foreground'
  return (
    <div className={`mt-1 flex items-center gap-1.5 text-body ${toneClass}`}>
      {icon}
      <span>{label}</span>
      {durationLabel && <span className="opacity-70">· {durationLabel}</span>}
      {copyText !== undefined && <CopyButton text={copyText} />}
      {onRegenerate && <RegenerateButton onClick={onRegenerate} />}
    </div>
  )
}
