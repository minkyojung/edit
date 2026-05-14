import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BrainIcon,
  ChevronDownIcon,
  MessageCircleIcon,
  PencilIcon,
  WrenchIcon,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReasoningPart, ToolPart } from '@/chat/types'
import { PROPOSE_CHANGE_TOOL } from '@/chat/parts/proposeChangeTool'
import { humanizeToolCall } from '@/chat/humanizers'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from '@/components/ai-elements/chain-of-thought'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

type ProcessPart = ReasoningPart | ToolPart

/** Outer "process" collapsible for one turn. Holds reasoning (merged
 * into a single first step) and every tool call (each its own step).
 * The outer chain auto-opens during streaming and auto-closes ~1s
 * after settle so finished turns stay compact; each inner step starts
 * collapsed and reveals its detail only when the user clicks. Streaming
 * inner steps stay collapsed too — labels arrive in order over the
 * stream, and detail is one click away. */
export function ProcessChain({
  parts,
  isStreaming,
}: {
  parts: ProcessPart[]
  isStreaming: boolean
}) {
  const [open, setOpen] = useState(isStreaming)
  useEffect(() => {
    if (isStreaming) {
      setOpen(true)
      return
    }
    const t = window.setTimeout(() => setOpen(false), 1000)
    return () => window.clearTimeout(t)
  }, [isStreaming])

  const reasoningParts = parts.filter(
    (p): p is ReasoningPart => p.type === 'reasoning',
  )
  const toolParts = parts.filter((p): p is ToolPart => p.type === 'tool')
  // Anthropic sometimes re-opens a thinking block between tool rounds;
  // we fold every reasoning fragment into one step so the chain reads
  // as one continuous thought rather than three near-identical entries.
  const mergedThinking = reasoningParts
    .map((p) => p.text)
    .filter((t) => t && t.length > 0)
    .join('\n\n')

  if (parts.length === 0) return null

  return (
    <ChainOfThought open={open} onOpenChange={setOpen} className="my-3">
      <ChainOfThoughtHeader>
        {headerLabel(toolParts, reasoningParts, isStreaming)}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {mergedThinking.length > 0 && (
          <CollapsibleStep
            icon={BrainIcon}
            label="Thinking"
            status="complete"
            detail={
              <div className="whitespace-pre-wrap">{mergedThinking}</div>
            }
          />
        )}
        {toolParts.map((part) => (
          <ToolStep key={part.id} part={part} />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  )
}

const stepStatusStyles = {
  active: 'text-foreground',
  complete: 'text-muted-foreground',
  pending: 'text-muted-foreground/50',
}

/** One row of the chain — icon + connecting line + label that reveals
 * a detail panel when clicked. Visual structure mirrors AI Elements'
 * ChainOfThoughtStep so the timeline reads as one element; the right
 * column wraps in a Collapsible so each row's detail is independently
 * expandable. Rows without detail render the label as plain text
 * (no chevron, no click affordance). */
function CollapsibleStep({
  icon: Icon,
  label,
  detail,
  status = 'complete',
}: {
  icon: LucideIcon
  label: ReactNode
  detail?: ReactNode
  status?: 'active' | 'complete' | 'pending'
}) {
  const hasDetail = detail != null
  return (
    <div
      className={cn(
        'flex gap-2 text-sm',
        stepStatusStyles[status],
        'fade-in-0 slide-in-from-top-2 animate-in',
      )}
    >
      <div className="relative mt-0.5 shrink-0">
        <Icon className="size-4" />
        <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />
      </div>
      <Collapsible className="flex-1 overflow-hidden">
        {hasDetail ? (
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 text-left hover:text-foreground">
            <span className="flex-1 min-w-0 break-words">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        ) : (
          <div className="break-words">{label}</div>
        )}
        {hasDetail && (
          <CollapsibleContent className="pt-2 text-muted-foreground text-xs data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
            {detail}
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  )
}

function ToolStep({ part }: { part: ToolPart }) {
  const { label } = humanizeToolCall(part.toolName, part.input, part.output)
  const isPropose = part.toolName === PROPOSE_CHANGE_TOOL
  const proposalInput = isPropose
    ? ((part.input ?? {}) as ProposeChangeInput)
    : null
  const isComment = proposalInput?.kind === 'comment'
  const icon: LucideIcon = isPropose
    ? isComment
      ? MessageCircleIcon
      : PencilIcon
    : WrenchIcon
  const status: 'active' | 'complete' | 'pending' =
    part.state === 'input-streaming' || part.state === 'input-available'
      ? 'active'
      : part.state === 'approval-requested'
        ? 'pending'
        : 'complete'
  return (
    <CollapsibleStep
      icon={icon}
      label={label}
      detail={renderToolDetail(part, proposalInput, isComment)}
      status={status}
    />
  )
}

interface ProposeChangeInput {
  kind?: 'suggestion' | 'comment'
  suggestionType?: 'insert' | 'delete' | 'replace'
  quote?: string
  content?: string
  text?: string
  rationale?: string
}

function renderToolDetail(
  part: ToolPart,
  proposalInput: ProposeChangeInput | null,
  isComment: boolean,
): ReactNode {
  if (proposalInput) {
    const replacement = proposalInput.content ?? proposalInput.text
    const hasBody =
      proposalInput.quote || replacement || proposalInput.rationale
    if (!hasBody) return null
    return (
      <div className="space-y-1.5">
        {proposalInput.quote && (
          <div className="line-through opacity-80">{proposalInput.quote}</div>
        )}
        {!isComment && replacement && (
          <div className="text-foreground/90">→ {replacement}</div>
        )}
        {isComment && replacement && (
          <div className="text-foreground/90">{replacement}</div>
        )}
        {proposalInput.rationale && (
          <div className="pt-1">{proposalInput.rationale}</div>
        )}
      </div>
    )
  }
  // Generic tool: render input as a compact JSON snapshot.
  if (part.input != null && typeof part.input === 'object') {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
        {JSON.stringify(part.input, null, 2)}
      </pre>
    )
  }
  if (typeof part.input === 'string' && part.input.length > 0) {
    return <div className="whitespace-pre-wrap">{part.input}</div>
  }
  return null
}

/** Dynamic outer header. Counts user-facing actions when settled,
 * falls back to a generic working label while still streaming. */
function headerLabel(
  toolParts: ToolPart[],
  reasoningParts: ReasoningPart[],
  isStreaming: boolean,
): string {
  if (isStreaming) return 'Working…'
  const proposals = toolParts.filter((p) => p.toolName === PROPOSE_CHANGE_TOOL)
  if (proposals.length > 0) {
    const n = proposals.length
    return n === 1 ? 'Suggested 1 change' : `Suggested ${n} changes`
  }
  if (toolParts.length > 0) return 'Worked on the document'
  if (reasoningParts.length > 0) return 'Thought it through'
  return 'Process'
}
