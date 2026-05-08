// Floating action surface for proofSuggestion marks. Anchored to the *end*
// of the suggestion (right after the last character / ghost replacement),
// rendered on hover with a 150ms leave-grace so the cursor can travel from
// the mark to the bar without flicker.
//
// This is the SINGLE surface for suggestions: rationale + [Keep] / [Reject]
// live here together. The older click → popover flow is reserved for
// comments only (see MarkPopoverLayer).
//
// Positioning: handed off entirely to Floating UI. We feed it a virtual
// reference whose `getBoundingClientRect` queries the live mark geometry
// (from markHoverGeometry) every time, so window resize, scroll, font
// loading, and content reflow all keep the bar attached without extra
// listeners on our side. `autoUpdate` covers the trigger plumbing.

import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { IconCheck, IconX } from '@tabler/icons-react'
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from '@floating-ui/react-dom'
import type { EditorView } from '@milkdown/kit/prose/view'
import { acceptMark, rejectMark } from '@/editor/markActions'
import { MARK_HOVER_EVENT, type MarkHoverDetail } from '@/editor/markHoverPlugin'
import { getMarkEndRect } from '@/editor/markHoverGeometry'
import { useMarks } from '@/hooks/useMarks'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

const LEAVE_DELAY_MS = 150
const BAR_GAP_PX = 6
// When the live mark has been removed (just accepted/rejected, doc edited
// past it, etc.) we can't return null — Floating UI expects a rect — so
// we hand it an off-screen rect and the layer separately decides to
// unmount the bar.
const OFFSCREEN_RECT: DOMRect = new DOMRect(-9999, -9999, 0, 0)

export function MarkHoverActionsLayer({ editorView, ydoc }: Props) {
  const [activeMarkId, setActiveMarkId] = useState<string | null>(null)
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
      setActiveMarkId(null)
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
      setActiveMarkId(detail.markId)
    }
    window.addEventListener(MARK_HOVER_EVENT, onHover)
    return () => {
      window.removeEventListener(MARK_HOVER_EVENT, onHover)
      cancelClose()
    }
  }, [])

  // Virtual reference that always reads the LIVE mark rect. Stable identity
  // keyed on (view, markId) so Floating UI's autoUpdate keeps a single
  // subscription instead of churning on every render.
  const virtualReference = useMemo<VirtualElement | null>(() => {
    if (!editorView || !activeMarkId) return null
    return {
      getBoundingClientRect() {
        return getMarkEndRect(editorView, activeMarkId) ?? OFFSCREEN_RECT
      },
    }
  }, [editorView, activeMarkId])

  const { refs, floatingStyles } = useFloating({
    elements: { reference: virtualReference ?? undefined },
    // Default below the suggestion (footnote-style — matches GitHub PR
    // review, Notion comments, VS Code lightbulb). Flip above when the
    // mark sits near the viewport bottom; only fall back to the right of
    // the suggestion as a last resort. shift keeps the bar in viewport.
    placement: 'bottom-start',
    middleware: [
      offset(BAR_GAP_PX),
      flip({ fallbackPlacements: ['top-start', 'right-start'] }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  if (!activeMarkId || !editorView || !ydoc) return null
  const stored = marks[activeMarkId]
  if (!stored) return null
  const rationale = stored.note?.trim() || null

  function handleAccept() {
    if (!editorView || !ydoc || !activeMarkId) return
    acceptMark(editorView, ydoc, activeMarkId)
    cancelClose()
    setActiveMarkId(null)
  }

  function handleReject() {
    if (!editorView || !ydoc || !activeMarkId) return
    rejectMark(editorView, ydoc, activeMarkId)
    cancelClose()
    setActiveMarkId(null)
  }

  return (
    <div
      ref={refs.setFloating}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      style={{ ...floatingStyles, zIndex: 50 }}
      className="flex max-w-80 flex-col gap-2 rounded-2xl border border-border bg-popover px-3 pt-2.5 pb-2 shadow-md"
    >
      {rationale && (
        <p className="text-[12.5px] leading-snug text-foreground/85">{rationale}</p>
      )}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleReject}
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
          onClick={handleAccept}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/90 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <IconCheck size={12} stroke={2.25} />
          Keep
        </button>
      </div>
    </div>
  )
}
