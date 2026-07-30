import type { ReactNode } from 'react'
import { IconLoader2, IconRobot } from '@tabler/icons-react'
import { isToolCallInFlight } from '@/chat/types'
import type { ToolPart } from '@/chat/types'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { useBackgroundTasks, type BackgroundTask } from '@/stores/backgroundTasks'

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
  const input = (part.input ?? {}) as { description?: string; subagent_type?: string }
  const description = input.description?.trim() || 'Subagent task'
  // The role/agent that was invoked (e.g. `translator`) — the lane's identity.
  // Make it the headline so the user sees WHICH agent is running; the task
  // description rides along as the preview. Plugin-loaded agents arrive
  // namespaced (`writer-agent-skills:translator`); strip the plugin prefix so
  // the user sees the bare role name.
  const agentType = input.subagent_type?.trim().replace(/^writer-agent-skills:/, '')
  const label = agentType || description

  // Background-task store overlay (persistent-query path). task_ids are globally
  // unique, so find by toolCallId across threads — no threadId plumbing needed.
  // The store is the single writer of background status, so it WINS when present;
  // `part.state`/`part.task` are the fallback for the legacy per-turn path. This
  // is required, not just tidy: a backgrounded subagent never gets a tool_result,
  // so `part.state` can't advance and would spin forever without the store.
  const bg = useBackgroundTasks((s): BackgroundTask | undefined => {
    const id = part.toolCallId
    for (const thread of Object.values(s.byThread)) {
      if (thread[id]) return thread[id]
    }
    return undefined
  })

  const running = bg
    ? bg.status === 'running'
    : isToolCallInFlight(part)

  const task = part.task
  const heartbeat = (() => {
    const toolUses = bg?.toolUses ?? task?.toolUses
    const totalTokens = bg?.totalTokens ?? task?.totalTokens
    const lastTool = bg?.lastTool ?? task?.lastTool
    const bits = [
      toolUses != null && `${toolUses} tool${toolUses === 1 ? '' : 's'}`,
      totalTokens != null && `${formatK(totalTokens)} tokens`,
      lastTool && `last: ${lastTool}`,
    ].filter(Boolean)
    return bits.length ? bits.join(' · ') : undefined
  })()
  // Completed background task → show its result summary; else the AI progress
  // summary ("Analyzing the outline"); else the raw heartbeat; else description.
  const activity =
    bg?.resultSummary?.trim() ||
    bg?.summary?.trim() ||
    task?.summary?.trim() ||
    heartbeat ||
    (agentType ? description : undefined)

  return (
    <ActivityRow
      icon={<IconRobot size={14} />}
      label={label}
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
