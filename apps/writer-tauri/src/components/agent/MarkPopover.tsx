// Compact action popover anchored to an inline mark in the editor body.
//
// Layout (3 rows, fixed width / variable height):
//   ┌──────────────────────────────────────────────┐
//   │ Rationale (full width, may wrap)             │
//   │ [..left [middle] right..]                    │ ← preview = content-width
//   │                                  [ ✓ │ ✕ ]   │ ← pill, bottom-right
//   └──────────────────────────────────────────────┘
//
// Why content-width preview: fade overlays must sit at the actual text
// edges, otherwise they fall over empty popover background and become
// invisible. By giving the preview wrapper `w-fit max-w-full overflow-hidden`,
// fade is always anchored to the text — visible whether the context is
// short or overflows.

import { useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Proposal } from '@/agent/proposals'

export interface Preview {
  left: string
  middle: string
  right: string
  mode: 'add' | 'remove'
}

interface Props {
  open: boolean
  rect: DOMRect | null
  proposal: Proposal | null
  preview: Preview | null
  onAccept: () => void
  onReject: () => void
  onClose: () => void
}

export function MarkPopover({ open, rect, proposal, preview, onAccept, onReject, onClose }: Props) {
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
        // Don't auto-focus the first interactive child — that was popping
        // the Accept tooltip every time the popover opened.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-auto max-w-[28rem] min-w-[18rem] p-3 space-y-0"
      >
        {proposal.rationale && (
          <p className="text-sm font-medium text-foreground leading-snug">{proposal.rationale}</p>
        )}

        {proposal.kind === 'comment' ? (
          <div className="flex items-start gap-2">
            <p className="flex-1 text-sm text-foreground leading-snug">{proposal.text}</p>
            <div className="ml-auto">
              <ActionPill onAccept={onAccept} onReject={onReject} />
            </div>
          </div>
        ) : preview ? (
          <div className="flex items-center gap-2">
            <PreviewRow preview={preview} />
            <div className="ml-auto">
              <ActionPill onAccept={onAccept} onReject={onReject} />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <FallbackDiff proposal={proposal} />
            <div className="ml-auto">
              <ActionPill onAccept={onAccept} onReject={onReject} />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function PreviewRow({ preview }: { preview: Preview }) {
  return (
    <div className="relative w-fit max-w-full overflow-hidden">
      <div className="whitespace-nowrap text-sm leading-snug">
        <span className="text-muted-foreground">{preview.left}</span>
        {preview.mode === 'add' ? (
          <span className="rounded bg-success/15 px-1 text-success">
            {preview.middle}
          </span>
        ) : (
          <span className="rounded bg-destructive/15 px-1 text-destructive line-through">
            {preview.middle}
          </span>
        )}
        <span className="text-muted-foreground">{preview.right}</span>
      </div>
      {preview.left.length > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-popover to-transparent"
        />
      )}
      {preview.right.length > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-popover to-transparent"
        />
      )}
    </div>
  )
}

function FallbackDiff({ proposal }: { proposal: Extract<Proposal, { kind: 'suggestion' }> }) {
  return (
    <div className="text-sm">
      {proposal.suggestionType === 'delete' ? (
        <span className="rounded bg-destructive/15 px-1 text-destructive line-through">
          {proposal.quote}
        </span>
      ) : (
        <span className="rounded bg-success/15 px-1 text-success">
          {proposal.content}
        </span>
      )}
    </div>
  )
}

function ActionPill({ onAccept, onReject }: { onAccept: () => void; onReject: () => void }) {
  return (
    <div className="inline-flex shrink-0 items-center gap-1.5">
      {/* Undo (was Reject) — ghost icon on the left */}
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

      {/* Keep (was Accept) — primary, filled, text + on the right */}
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
