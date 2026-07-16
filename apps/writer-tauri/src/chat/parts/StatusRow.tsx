import { IconLoader2 } from '@tabler/icons-react'
import type { StatusPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** A live `system/status` the model is in the middle of — currently only
 * `compacting` (summarizing older turns to fit the window). Without this the
 * multi-second compaction pause shows nothing and reads as a hang. Rendered
 * through ActivityRow like the retry row, with a spinning icon to signal it's
 * active; it folds into the process summary once the turn moves on. The
 * end-of-compaction divider is the separate {@link CompactDivider}. */
export function StatusRow({ part }: { part: StatusPart }) {
  return (
    <ActivityRow
      icon={<IconLoader2 size={14} className="animate-spin" />}
      label={STATUS_LABELS[part.state]}
    />
  )
}

const STATUS_LABELS: Record<StatusPart['state'], string> = {
  compacting: 'Summarizing earlier context…',
}
