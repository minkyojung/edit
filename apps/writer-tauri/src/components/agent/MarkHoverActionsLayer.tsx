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
import {
  acceptMark,
  hasProofSuggestionInDoc,
  rejectMark,
} from '@/editor/markActions'
import { MARK_HOVER_EVENT, type MarkHoverDetail } from '@/editor/markHoverPlugin'
import { getMarkEndRect } from '@/editor/markHoverGeometry'
import { useMarks } from '@/hooks/useMarks'
import { useDocsStore } from '@/state/docsStore'
import { formatActor } from '@/lib/formatActor'
import { formatRelative } from '@/lib/formatRelative'

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
  // Visibility authority is the live PM mark, NOT Y.Map. PM undo
  // restores the mark; Y.Map mutations from accept/reject aren't on
  // PM's undo stack, so a Y.Map-gated check would hide the toolbar
  // after Cmd+Z even though the suggestion is back in the doc. See
  // markCleanupPlugin.ts:1-7 for the codebase-wide invariant this
  // mirrors.
  if (!hasProofSuggestionInDoc(editorView, activeMarkId)) return null
  // Y.Map metadata is optional decoration: rationale text shows when
  // it's there, the toolbar still works when it isn't.
  const stored = marks[activeMarkId]
  const rationale = stored?.note?.trim() || null
  const actor = formatActor(stored?.by)
  const proposedAt = stored?.at ? formatRelative(stored.at) : null
  // Author label sits to the left of the action buttons. We hide
  // the whole row when neither piece of metadata is known so the
  // bar stays clean for marks that were seeded without provenance.
  const hasMeta = actor !== null || proposedAt !== null

  function handleAccept() {
    if (!editorView || !ydoc || !activeMarkId) return
    const slug = useDocsStore.getState().activeSlug
    if (!slug) return
    // Fire-and-forget: server-driven state change syncs back via the
    // WebSocket; we close the toolbar immediately so the cursor isn't
    // blocked by the floating UI while the ops round-trip resolves.
    void acceptMark(slug, editorView, ydoc, activeMarkId)
    cancelClose()
    setActiveMarkId(null)
  }

  function handleReject() {
    if (!editorView || !ydoc || !activeMarkId) return
    const slug = useDocsStore.getState().activeSlug
    if (!slug) return
    void rejectMark(slug, editorView, ydoc, activeMarkId)
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
      <div className="flex items-center justify-between gap-2">
        {hasMeta ? (
          <span className="flex min-w-0 items-center gap-1 text-[11px] leading-none text-muted-foreground opacity-80">
            {actor && <span className="truncate">{actor}</span>}
            {actor && proposedAt && <span className="opacity-40">·</span>}
            {proposedAt && <span className="truncate">{proposedAt}</span>}
          </span>
        ) : (
          <span aria-hidden />
        )}
        <span className="flex items-center gap-1">
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
        </span>
      </div>
    </div>
  )
}
