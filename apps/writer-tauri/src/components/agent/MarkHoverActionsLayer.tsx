// Floating action surface for proofSuggestion marks. Anchored to the *end*
// of the suggestion (right after the last character / ghost replacement),
// rendered on hover with a 150ms leave-grace so the cursor can travel from
// the mark to the bar without flicker.
//
// This is the SINGLE surface for suggestions: rationale + [Keep] / [Reject]
// live here together. The older click → popover flow is reserved for
// comments only (see MarkPopoverLayer).

import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { IconCheck, IconX } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { acceptMark, rejectMark } from '@/editor/markActions'
import { MARK_HOVER_EVENT, type MarkHoverDetail } from '@/editor/markHoverPlugin'
import { useMarks } from '@/hooks/useMarks'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

interface Active {
  markId: string
  rect: NonNullable<MarkHoverDetail['rect']>
}

const LEAVE_DELAY_MS = 150
const BAR_GAP_PX = 6

export function MarkHoverActionsLayer({ editorView, ydoc }: Props) {
  const [active, setActive] = useState<Active | null>(null)
  const leaveTimer = useRef<number | null>(null)
  const marks = useMarks(ydoc)

  function cancelClose() {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
  }

  function scheduleClose() {
    cancelClose()
    leaveTimer.current = window.setTimeout(() => {
      setActive(null)
      leaveTimer.current = null
    }, LEAVE_DELAY_MS)
  }

  useEffect(() => {
    function onHover(e: Event) {
      const detail = (e as CustomEvent<MarkHoverDetail>).detail
      if (!detail) return
      if (detail.markId === null) {
        scheduleClose()
        return
      }
      cancelClose()
      setActive({ markId: detail.markId, rect: detail.rect! })
    }
    window.addEventListener(MARK_HOVER_EVENT, onHover)
    return () => {
      window.removeEventListener(MARK_HOVER_EVENT, onHover)
      cancelClose()
    }
  }, [])

  if (!active || !editorView || !ydoc) return null

  const stored = marks[active.markId]
  // Pull rationale only — comment text and other meta belong on the
  // (separate) comment popover surface.
  const rationale = stored?.note?.trim() || null

  function handleAccept() {
    if (!editorView || !ydoc || !active) return
    acceptMark(editorView, ydoc, active.markId)
    cancelClose()
    setActive(null)
  }

  function handleReject() {
    if (!editorView || !ydoc || !active) return
    rejectMark(editorView, ydoc, active.markId)
    cancelClose()
    setActive(null)
  }

  return (
    <Bar
      rect={active.rect}
      rationale={rationale}
      editorEl={editorView.dom}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      onAccept={handleAccept}
      onReject={handleReject}
    />
  )
}

interface BarProps {
  rect: NonNullable<MarkHoverDetail['rect']>
  rationale: string | null
  editorEl: HTMLElement
  onMouseEnter: () => void
  onMouseLeave: () => void
  onAccept: () => void
  onReject: () => void
}

function Bar({ rect, rationale, editorEl, onMouseEnter, onMouseLeave, onAccept, onReject }: BarProps) {
  // Vertical stack: rationale on top, action row below. The container
  // auto-sizes to the text (no truncation, no morphing) and always sits
  // below the suggestion so it never overlaps the next line of body text.
  const APPROX_W = 320
  const APPROX_H = rationale ? 72 : 36

  const editorRight = editorEl.getBoundingClientRect().right
  const wantLeft = rect.right + BAR_GAP_PX
  const overflowsColumn = wantLeft + APPROX_W > editorRight - 8

  const left = overflowsColumn
    ? Math.max(8, Math.min(rect.right - APPROX_W, window.innerWidth - APPROX_W - 8))
    : wantLeft

  const top = overflowsColumn
    ? rect.bottom + BAR_GAP_PX
    : rect.top + rect.height / 2 - APPROX_H / 2

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: 'fixed', top, left, zIndex: 50 }}
      className="flex max-w-80 flex-col gap-2 rounded-2xl border border-border bg-popover px-3 pt-2.5 pb-2 shadow-md"
    >
      {rationale && (
        <p className="text-[12.5px] leading-snug text-foreground/85">{rationale}</p>
      )}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onReject}
          aria-label="Discard"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <IconX size={12} stroke={2} />
        </button>
        <button
          type="button"
          // mousedown.preventDefault keeps the editor selection alive when
          // the click hits the button (otherwise the doc loses focus and
          // the next typed key goes nowhere).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAccept}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/90 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <IconCheck size={12} stroke={2.25} />
          Keep
        </button>
      </div>
    </div>
  )
}
