// Compact action popover anchored to an inline mark in the editor body.
//
// The diff (red original / green replacement) is rendered inline in the
// document via mark decorations + ghost widgets, so this popover only
// carries the action surface and any rationale/comment text.

import { useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Proposal } from '@/agent/proposals'

interface Props {
  open: boolean
  rect: DOMRect | null
  proposal: Proposal | null
  onAccept: () => void
  onReject: () => void
  onClose: () => void
}

export function MarkPopover({ open, rect, proposal, onAccept, onReject, onClose }: Props) {
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = anchorRef.current
    if (!el || !rect) return
    el.style.left = `${rect.left + window.scrollX}px`
    el.style.top = `${rect.top + window.scrollY}px`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
  }, [rect])

  // Cmd/Ctrl+Enter accept while popover is open. Esc is handled by Radix.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onAccept()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onAccept])

  if (!proposal) return null

  const isComment = proposal.kind === 'comment'

  return (
    <Popover open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          aria-hidden
          className="pointer-events-none fixed"
          style={{ left: 0, top: 0, width: 0, height: 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-auto max-w-[24rem] min-w-[10rem] p-3 space-y-2"
      >
        {proposal.rationale && (
          <p className="text-sm font-medium text-foreground leading-snug">{proposal.rationale}</p>
        )}

        {isComment && proposal.text && (
          <p className="text-sm text-foreground leading-snug">{proposal.text}</p>
        )}

        <div className="flex justify-end">
          <ActionPill onAccept={onAccept} onReject={onReject} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ActionPill({ onAccept, onReject }: { onAccept: () => void; onReject: () => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReject}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground active:scale-95 focus-visible:ring-3 focus-visible:ring-ring/30"
            aria-label="Undo"
          >
            <IconX size={14} stroke={1.75} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Undo (Esc)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onAccept}
            className="inline-flex h-7 items-center rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/90 active:scale-95 focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            Keep
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Keep (⌘↵)</TooltipContent>
      </Tooltip>
    </div>
  )
}
