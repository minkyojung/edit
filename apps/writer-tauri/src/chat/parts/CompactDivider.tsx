import { IconArrowsDiagonalMinimize2 } from '@tabler/icons-react'
import type { CompactPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** A `compact_boundary` marker — the SDK condensed the earlier conversation to
 * stay under the context window. Rendered through ActivityRow so it shares the
 * activity stream's look, but with no `detail` it stays a passive divider (no
 * chevron, no hover, nothing to expand) — design unified, role a boundary. */
export function CompactDivider({ part }: { part: CompactPart }) {
  const tokens =
    part.preTokens != null && part.postTokens != null
      ? ` · ${formatK(part.preTokens)}→${formatK(part.postTokens)} tokens`
      : ''
  return (
    <ActivityRow
      icon={<IconArrowsDiagonalMinimize2 size={14} />}
      label={`Earlier context summarized${tokens}`}
    />
  )
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
