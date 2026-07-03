import type { ReactNode } from 'react'
import { IconLoader2, IconRobot } from '@tabler/icons-react'
import type { ToolPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'

/** One subagent as a top-level Agent row — a Task delegation.
 *
 * The description (which note / topic this lane owns) is the HEADLINE so
 * parallel lanes are distinguishable at a glance; the live heartbeat
 * (tool/token counts + last tool, from `task_progress` system messages) rides
 * along as a dim inline suffix that stays visible, and a spinner marks a lane
 * that's still running.
 *
 * When `steps` are present (Level 2, forwardSubagentText on) the row becomes
 * expandable: collapsed shows the headline + heartbeat, expanded reveals the
 * subagent's actual transcript. With no steps (heartbeat-only) it stays a
 * static line — there's nothing to drill into. */
export function TaskActivity({ part, steps }: { part: ToolPart; steps?: ReactNode }) {
  const input = (part.input ?? {}) as { description?: string }
  const description = input.description?.trim() || 'Subagent task'
  const running =
    part.state === 'input-streaming' || part.state === 'input-available'

  const task = part.task
  const heartbeat = task
    ? [
        task.toolUses != null && `${task.toolUses} tool${task.toolUses === 1 ? '' : 's'}`,
        task.totalTokens != null && `${formatK(task.totalTokens)} tokens`,
        task.lastTool && `last: ${task.lastTool}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined
  // Prefer the AI-generated summary ("Analyzing the outline") — it says what the
  // subagent is DOING in plain terms. Fall back to the raw tool/token counter.
  const activity = task?.summary?.trim() || heartbeat

  return (
    <ActivityRow
      icon={<IconRobot size={14} />}
      label={description}
      preview={activity || undefined}
      trailing={
        running ? (
          <IconLoader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />
        ) : undefined
      }
      detail={steps}
    />
  )
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
