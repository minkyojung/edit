import { IconLoader2, IconRobot } from '@tabler/icons-react'
import type { ToolPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** Renders a Task tool call — the model delegating work to a subagent — as an
 * activity row. Phase 1 (heartbeat): the subagent runs out-of-band and the
 * `task_progress` system messages stamp tool/token counts onto the part, shown
 * here as a compact summary. (Phase 2 would nest the subagent's full transcript
 * in the detail.) */
export function TaskActivity({ part }: { part: ToolPart }) {
  const input = (part.input ?? {}) as { description?: string }
  const description = input.description?.trim() || 'Subagent task'
  const running =
    part.state === 'input-streaming' || part.state === 'input-available'

  const task = part.task
  const summary = task
    ? [
        task.toolUses != null && `${task.toolUses} tool${task.toolUses === 1 ? '' : 's'}`,
        task.totalTokens != null && `${formatK(task.totalTokens)} tokens`,
        task.lastTool && `last: ${task.lastTool}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <ActivityRow
      icon={<IconRobot size={14} />}
      label="Agent"
      preview={description}
      trailing={
        running ? (
          <IconLoader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />
        ) : undefined
      }
      detail={summary ? <div className="text-muted-foreground">{summary}</div> : undefined}
    />
  )
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
