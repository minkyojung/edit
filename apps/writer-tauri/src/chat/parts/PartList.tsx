import type { ReactNode } from 'react'
import type { MessagePart, ToolPart as ToolPartType } from '@/chat/types'
import { TextPart } from '@/chat/parts/TextPart'
import { ToolPart } from '@/chat/parts/ToolPart'
import { ThinkingPill } from '@/chat/parts/ReasoningPart'
import { ProcessGroup } from '@/chat/parts/ProcessGroup'
import { QuestionActivity } from '@/chat/parts/QuestionActivity'
import { TodoActivity } from '@/chat/parts/TodoActivity'
import { TaskActivity } from '@/chat/parts/TaskActivity'
import { CompactDivider } from '@/chat/parts/CompactDivider'
import { RetryRow } from '@/chat/parts/RetryRow'
import { StatusRow } from '@/chat/parts/StatusRow'
import { NoticeRow } from '@/chat/parts/NoticeRow'
import { isProposeEditTool } from '@/chat/parts/proposeChangeTool'
import { InlineSuggestion } from '@/chat/suggestions/InlineSuggestion'
import { usePendingChangesStore } from '@/state/pendingChangesStore'

/** Walks an assistant turn's timeline and reshapes it for rendering:
 *  - reasoning + non-edit tool calls form the turn's "process". They render as
 *    `ActivityRow`s in timeline order, all tucked under one collapsed-by-default
 *    `ProcessGroup` summary at the top ("N tool calls, M messages") so the
 *    transcript stays clean. Consecutive reasoning fragments merge into one pill
 *    (Anthropic re-opens the thinking block between tool rounds).
 *  - text parts render below the group as the answer body — the white primary
 *    content, the focus of the turn.
 *  - edit-tool parts (propose_edit / write / multi_edit) render INLINE in the
 *    body at their timeline position (an ActivityRow header + diff), so a
 *    proposal sits where the tool actually ran — e.g. above a closing summary —
 *    instead of being bucketed to the end. They stay OUT of the collapsed
 *    process group so the proposed change is always visible for review.
 * step-start parts are no-ops (sidecar never emits them today). */
export function PartList({
  parts,
  isStreaming,
  hideText = false,
}: {
  parts: MessagePart[]
  isStreaming: boolean
  /** Suppress text parts — used for a parked plan turn, whose plan lives in
   * the approval card, so the (often redundant) answer text isn't shown twice. */
  hideText?: boolean
}) {
  // Subscribed so the duplicate-shell filter below re-evaluates as proposals
  // land in / leave the store.
  const changesById = usePendingChangesStore((s) => s.byId)

  const compactNodes: ReactNode[] = []
  const processRows: ReactNode[] = []
  // Answer-level nodes: the orchestrator's narration text AND its Agent rows,
  // kept in TIMELINE order. So an intro ("spinning up 4 agents") sits ABOVE the
  // agents it announces and a closing summary sits below them — bucketing every
  // text part under the agents (as an earlier cut did) read unnaturally.
  // Subagent (Task) rows are pulled out of the collapsed process group and live
  // here as top-level expandable Agent rows, in the spot they were spawned.
  const bodyNodes: ReactNode[] = []
  const questionParts: ToolPartType[] = []

  // Subagent attribution (Level 2): parts the SDK tagged with a parentToolUseId
  // belong to a Task lane, not the main timeline — group them by parent so each
  // lane renders its own nested transcript. EXCEPTION: a subagent's edit
  // proposals (propose_*) still surface at the TURN level for review (the
  // Keep/Reject flow is turn-scoped), so they stay in the main stream.
  const childByParent = new Map<string, MessagePart[]>()
  const mainParts: MessagePart[] = []
  for (const p of parts) {
    const pid =
      p.type === 'text' || p.type === 'reasoning' || p.type === 'tool'
        ? p.parentToolUseId
        : undefined
    const isSubagentEdit = p.type === 'tool' && isProposeEditTool(p.toolName)
    if (pid && !isSubagentEdit) {
      const arr = childByParent.get(pid)
      if (arr) arr.push(p)
      else childByParent.set(pid, [p])
    } else {
      mainParts.push(p)
    }
  }

  // Edit/write proposals render inline (in the loop below), but de-dupe first:
  // a turn that creates a note AND edits it fires two proposals for the same
  // file; only one resolves to a live store change (the other is a non-
  // actionable read-only "shell"). When a live edit exists for a file, hide the
  // shells for that file so the user sees one actionable row; a lone shell (no
  // live sibling) still renders so past edits stay visible. Computed up front so
  // the loop can decide visibility at each edit's own timeline position.
  const isLiveEdit = (p: ToolPartType) => !!(p.pendingId && changesById[p.pendingId])
  const liveFileKeys = new Set(
    mainParts
      .filter(
        (p): p is ToolPartType =>
          p.type === 'tool' && isProposeEditTool(p.toolName),
      )
      .filter(isLiveEdit)
      .map(editFileKey),
  )
  const isVisibleEdit = (p: ToolPartType) =>
    isLiveEdit(p) || !liveFileKeys.has(editFileKey(p))

  // The model re-issues the whole TodoWrite list each update. Render the LATEST
  // content at the FIRST call's timeline position (in-place update, matching
  // Claude Code) and skip the rest.
  const todoWriteParts = mainParts.filter(
    (p): p is ToolPartType => p.type === 'tool' && p.toolName === 'TodoWrite',
  )
  const latestTodo = todoWriteParts.at(-1)
  const firstTodoId = todoWriteParts[0]?.id
  let toolCount = 0
  let messageCount = 0

  // Buffer consecutive reasoning fragments and flush them as one pill the
  // moment a non-reasoning row (tool / text) or the end of the timeline is
  // reached.
  let reasoningBuf: string[] = []
  let reasoningKey: string | null = null
  const flushReasoning = () => {
    if (reasoningBuf.length === 0) return
    processRows.push(
      <ThinkingPill
        key={`reasoning-${reasoningKey}`}
        content={reasoningBuf.join('\n\n')}
        isStreaming={isStreaming}
      />,
    )
    messageCount++
    reasoningBuf = []
    reasoningKey = null
  }

  for (const part of mainParts) {
    switch (part.type) {
      case 'reasoning':
        if (part.text) {
          if (reasoningKey === null) reasoningKey = part.id
          reasoningBuf.push(part.text)
        }
        break
      case 'tool':
        flushReasoning()
        if (part.toolName === 'Agent' || part.toolName === 'Task') {
          // Delegated subagent — surfaced as its own TOP-LEVEL Agent row (NOT
          // folded into the collapsed process summary), so parallel fan-out
          // stays visible. The SDK names this tool 'Agent'; 'Task' is a
          // defensive alias. Level 2: its nested transcript (this subagent's own
          // reads/thinking/tools, tagged with parentToolUseId === toolCallId) is
          // passed as expandable steps.
          bodyNodes.push(
            <TaskActivity
              key={part.id}
              part={part}
              steps={renderSubagentSteps(childByParent.get(part.toolCallId), isStreaming)}
            />,
          )
        } else if (part.toolName === 'TodoWrite') {
          // Render the latest list at the first call's spot; later updates skip.
          if (part.id === firstTodoId && latestTodo) {
            processRows.push(<TodoActivity key="todo" part={latestTodo} />)
            toolCount++
          }
        } else if (part.toolName === 'AskUserQuestion') {
          // Interactive Q&A — render visibly as its own row, not buried in the
          // collapsed process group, and don't count it as a generic tool call.
          questionParts.push(part)
        } else if (isProposeEditTool(part.toolName)) {
          // Inline at the timeline position (into bodyNodes) so the proposal
          // sits where the tool ran — not bucketed to the end. Skip hidden
          // duplicate shells (a dropped edit for a file with a live sibling).
          if (isVisibleEdit(part)) {
            bodyNodes.push(<InlineSuggestion key={part.id} part={part} />)
          }
        } else {
          processRows.push(<ToolPart key={part.id} part={part} />)
          toolCount++
        }
        break
      case 'text':
        flushReasoning()
        if (!hideText) {
          bodyNodes.push(<TextPart key={part.id} part={part} isStreaming={isStreaming} />)
        }
        break
      case 'compact':
        flushReasoning()
        compactNodes.push(<CompactDivider key={part.id} part={part} />)
        break
      case 'retry':
        // Lives in the live process flow (not counted as a tool call): visible
        // while streaming, collapses into the process summary once settled.
        flushReasoning()
        processRows.push(<RetryRow key={part.id} part={part} />)
        break
      case 'status':
        // Transient live status (compacting) — folds into the process summary
        // once the turn moves on, same as the retry row.
        flushReasoning()
        processRows.push(<StatusRow key={part.id} part={part} />)
        break
      case 'notice':
        // Consequential notice (blocked tool / model fallback / SDK warning) —
        // stays in the body so it remains visible after the turn settles, not
        // hidden behind the collapsed process summary.
        flushReasoning()
        bodyNodes.push(<NoticeRow key={part.id} part={part} />)
        break
      case 'step-start':
        break
    }
  }
  flushReasoning()

  return (
    <>
      {compactNodes}
      {(processRows.length > 0 || isStreaming) && (
        <ProcessGroup
          summary={summarizeProcess(toolCount, messageCount)}
          isStreaming={isStreaming}
        >
          {processRows}
        </ProcessGroup>
      )}
      {/* Narration text and Agent rows interleaved in timeline order: intro
          above the agents it announces, agents (each a top-level expandable
          row, no "N subagents" wrapper), then the closing summary below. */}
      {bodyNodes}
      {questionParts.map((part) => (
        <QuestionActivity key={part.id} part={part} />
      ))}
    </>
  )
}

/** Render one subagent's nested transcript — the parts it produced (reads,
 * thinking, non-edit tool calls), in arrival order — as the expandable detail
 * of its top-level Agent row. The steps sit in a left-ruled, indented block so
 * that, once expanded, they read unambiguously as belonging to THAT agent (the
 * divider is what separates an agent from its own sub-tasks). Consecutive
 * reasoning fragments merge into a single pill, matching the main timeline.
 * Returns undefined when the agent has no nested steps yet (heartbeat-only), so
 * the row stays a static line. */
function renderSubagentSteps(
  parts: MessagePart[] | undefined,
  isStreaming: boolean,
): ReactNode {
  if (!parts || parts.length === 0) return undefined
  const rows: ReactNode[] = []
  let reasoningBuf: string[] = []
  let reasoningKey: string | null = null
  const flush = () => {
    if (reasoningBuf.length === 0) return
    rows.push(
      <ThinkingPill
        key={`r-${reasoningKey}`}
        content={reasoningBuf.join('\n\n')}
        isStreaming={isStreaming}
      />,
    )
    reasoningBuf = []
    reasoningKey = null
  }
  for (const p of parts) {
    if (p.type === 'reasoning') {
      if (p.text) {
        if (reasoningKey === null) reasoningKey = p.id
        reasoningBuf.push(p.text)
      }
    } else if (p.type === 'text') {
      flush()
      rows.push(<TextPart key={p.id} part={p} isStreaming={isStreaming} />)
    } else if (p.type === 'tool') {
      flush()
      if (p.toolName === 'TodoWrite') {
        rows.push(<TodoActivity key={p.id} part={p} />)
      } else if (p.toolName === 'AskUserQuestion') {
        rows.push(<QuestionActivity key={p.id} part={p} />)
      } else {
        // Includes a deeper Agent/Task (depth > 1): rendered as a plain tool
        // row rather than recursing, so the tree can't nest without bound.
        rows.push(<ToolPart key={p.id} part={p} />)
      }
    }
  }
  flush()
  return rows.length > 0 ? (
    <div className="ml-0.5 border-l border-border/50 pl-3">{rows}</div>
  ) : undefined
}

/** Group key for de-duping edit rows: the target file's FULL path (both the
 * live write and the dropped edit carry the exact same file_path string for
 * the same file, which is what this dedup is actually for). Previously keyed
 * by basename only, which collapsed two DIFFERENT files that happen to share
 * a filename in different folders (e.g. `inbox/Q3.md` and `daily/Q3.md`) —
 * hiding a genuine, unrelated proposal as if it were a duplicate shell. Falls
 * back to the part id so a path-less part is never collapsed into another. */
function editFileKey(part: ToolPartType): string {
  const fp = (part.input as { file_path?: string } | null | undefined)?.file_path
  return fp || part.id
}

/** "N tool calls, M messages" — counts only what the collapsed group hides
 * (non-edit tool rows + thinking pills); edits live outside it. */
function summarizeProcess(toolCount: number, messageCount: number): string {
  const segs: string[] = []
  if (toolCount > 0) segs.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`)
  if (messageCount > 0) segs.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`)
  return segs.join(', ')
}
