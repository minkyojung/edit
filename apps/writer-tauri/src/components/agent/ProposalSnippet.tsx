// Compact AI proposal card rendered inside chat assistant messages.
//
// Shows a diff-style preview (- old / + new), the model's rationale,
// and accept/reject actions that delegate to markActions. Once a mark
// is resolved (no longer in Y.Map) the card dims out.

import { IconArrowRight } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Proposal } from '@/agent/proposals'

const KIND_LABEL: Record<string, string> = {
  replace: 'Replace',
  insert: 'Insert',
  delete: 'Delete',
  comment: 'Comment',
}

const KIND_DOT: Record<string, string> = {
  replace: 'bg-yellow-400',
  insert: 'bg-green-400',
  delete: 'bg-red-400',
  comment: 'bg-blue-400',
}

export type ProposalCardStatus = 'pending' | 'accepted' | 'rejected'

interface Props {
  markId: string
  proposal: Proposal
  by: string
  status: ProposalCardStatus
  onAccept: () => void
  onReject: () => void
  onJump?: () => void
}

export function ProposalSnippet({ markId, proposal, by, status, onAccept, onReject, onJump }: Props) {
  const kind = proposal.kind === 'comment' ? 'comment' : proposal.suggestionType
  const resolved = status !== 'pending'

  return (
    <div
      data-snippet-mark-id={markId}
      className={
        'rounded-md border p-2.5 space-y-2 transition-opacity ' +
        (resolved
          ? 'border-border/50 bg-card/50 opacity-60'
          : 'border-border bg-card')
      }
    >
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
            KIND_DOT[kind ?? 'replace'] ?? 'bg-muted-foreground'
          }`}
        />
        <span className="font-medium text-foreground">
          {KIND_LABEL[kind ?? 'replace'] ?? kind}
        </span>
        <span className="text-muted-foreground truncate">{by}</span>
        {resolved && (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
            {status === 'accepted' ? 'Accepted' : 'Rejected'}
          </span>
        )}
        {!resolved && onJump && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-5 w-5"
                onClick={onJump}
              >
                <IconArrowRight size={12} stroke={1.75} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Show in document</TooltipContent>
          </Tooltip>
        )}
      </div>

      {proposal.kind === 'suggestion' ? (
        <DiffBlock
          quote={proposal.quote}
          content={proposal.content ?? ''}
          kind={proposal.suggestionType}
        />
      ) : (
        <CommentBlock quote={proposal.quote} text={proposal.text} />
      )}

      {proposal.rationale && (
        <p className="text-xs text-muted-foreground leading-snug">
          "{proposal.rationale}"
        </p>
      )}

      {!resolved && (
        <div className="flex gap-1.5 pt-0.5">
          <Button size="sm" className="h-6 flex-1 text-[11px]" onClick={onAccept}>
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 flex-1 text-[11px]"
            onClick={onReject}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

function DiffBlock({
  quote,
  content,
  kind,
}: {
  quote: string
  content: string
  kind: 'insert' | 'delete' | 'replace'
}) {
  return (
    <div className="font-mono text-[11px] space-y-0.5">
      {kind !== 'insert' && (
        <div className="rounded bg-red-500/10 px-2 py-1 text-red-700 dark:text-red-400 break-words">
          <span className="select-none opacity-60">− </span>
          {quote}
        </div>
      )}
      {kind !== 'delete' && content && (
        <div className="rounded bg-green-500/10 px-2 py-1 text-green-700 dark:text-green-400 break-words">
          <span className="select-none opacity-60">+ </span>
          {content}
        </div>
      )}
    </div>
  )
}

function CommentBlock({ quote, text }: { quote: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground italic leading-snug">"{quote}"</p>
      <p className="text-xs text-foreground leading-snug">{text}</p>
    </div>
  )
}
