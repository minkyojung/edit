import type { ReactNode } from 'react'
import {
  IconBan,
  IconInfoCircle,
  IconAlertTriangle,
  IconArrowsExchange,
} from '@tabler/icons-react'
import { labelForModel, type NoticePart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** A consequential mid-turn notice the SDK surfaced that isn't chat content: a
 * tool blocked by a permission rule, an automatic model fallback after a
 * refusal, or an SDK `informational` message. Persistent (unlike the transient
 * StatusRow) so the user can see *why* the turn behaved as it did. Composes its
 * own (localized) label from the part's raw fields, mirroring RetryRow. */
export function NoticeRow({ part }: { part: NoticePart }) {
  const { icon, label } = describe(part)
  return <ActivityRow icon={icon} label={label} />
}

function describe(part: NoticePart): { icon: ReactNode; label: string } {
  switch (part.kind) {
    case 'permission-denied': {
      const tool = part.toolName ?? 'A tool'
      const why = part.reason ? ` — ${part.reason}` : ''
      return { icon: <IconBan size={14} />, label: `Blocked: ${tool}${why}` }
    }
    case 'model-fallback': {
      // labelForModel, not the raw id: this row predates it and was printing
      // `claude-opus-4-8` right above a sibling row saying "Opus 4.8".
      const to = part.fallbackModel ? ` to ${labelForModel(part.fallbackModel)}` : ''
      return {
        icon: <IconArrowsExchange size={14} />,
        label: `Switched${to} after a safety refusal`,
      }
    }
    // The requested model isn't served through this path, so a different one
    // answered — with NO error at all. Naming both ends is the point: without
    // this row the reply silently comes from a model the picker isn't showing.
    case 'model-unavailable': {
      const asked = part.requestedModel ? labelForModel(part.requestedModel) : 'That model'
      const answered = part.fallbackModel ? labelForModel(part.fallbackModel) : 'another model'
      return {
        icon: <IconArrowsExchange size={14} />,
        label: `${asked} is unavailable — answered with ${answered}`,
      }
    }
    case 'info': {
      const warn = part.level === 'warning'
      const text = part.text ?? (warn ? 'Warning' : 'Notice')
      const suffix = part.blocking ? ' (stopped here)' : ''
      return {
        icon: warn ? <IconAlertTriangle size={14} /> : <IconInfoCircle size={14} />,
        label: `${text}${suffix}`,
      }
    }
  }
}
