// Floating pill toolbar that appears above a non-empty text selection,
// mirroring Apple Notes / Pages / Medium. Replaces the always-on
// FormatToolbar row so the editor header collapses to a single line and
// inline formatting controls become contextual — only visible when the
// user has something selected to format.
//
// Visibility is driven by `useFormatStateStore.selectionEmpty`, which
// the formatStatePlugin sets to true during empty selections AND during
// IME composition (Korean/Japanese/Chinese), preventing flicker while
// the user is mid-composing a character.
//
// Position is recomputed on every relevant event:
//   - selection change → plugin updates selectionRect → useLayoutEffect
//   - viewport scroll / resize → local handler recomputes from view.coordsAtPos
//
// The bubble itself is `position: fixed` (matching SlashMenu's pattern)
// so it doesn't have to live in a portal — Radix popovers nested inside
// (the Link button) handle their own portaling.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toggleMark } from '@milkdown/kit/prose/commands'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  IconBold,
  IconCode,
  IconItalic,
  IconLink,
  IconStrikethrough,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useEditorViewStore } from '@/state/editorViewStore'
import { useFormatStateStore } from '@/state/formatStateStore'
import { toggleInlineCodeSafe } from './inlineCodeSafe'
import { unionCoords } from './formatStatePlugin'
import { LinkEditInput } from './LinkEditInput'
import { applyLinkMark } from './linkUtils'

/** Vertical gap between the selection's bounding box and the bubble. */
const BUBBLE_GAP = 8

export function SelectionBubble() {
  const view = useEditorViewStore((s) => s.view)
  const selectionEmpty = useFormatStateStore((s) => s.selectionEmpty)
  const selectionRect = useFormatStateStore((s) => s.selectionRect)
  const activeMarks = useFormatStateStore((s) => s.activeMarks)

  const bubbleRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const visible = !!view && !selectionEmpty && !!selectionRect

  // Position recompute. useLayoutEffect so the measurement (offsetWidth /
  // offsetHeight) reads after the bubble has rendered with its actual
  // content but before the browser paints — avoids a one-frame flash at
  // the wrong position.
  useLayoutEffect(() => {
    if (!visible || !selectionRect || !bubbleRef.current) {
      setPos(null)
      return
    }
    const bubble = bubbleRef.current
    const w = bubble.offsetWidth
    const h = bubble.offsetHeight

    // Center horizontally over the selection.
    const selCenter = (selectionRect.left + selectionRect.right) / 2
    let left = selCenter - w / 2

    // Default above the selection; flip below if there isn't room.
    let top = selectionRect.top - h - BUBBLE_GAP
    if (top < 8) {
      top = selectionRect.bottom + BUBBLE_GAP
    }

    // Clamp horizontally so the bubble stays fully on-screen.
    const maxLeft = window.innerWidth - w - 8
    left = Math.max(8, Math.min(left, maxLeft))

    setPos({ top, left })
  }, [visible, selectionRect])

  // Follow the selection as the user scrolls or resizes the window.
  // The plugin only fires on transactions, so scroll-only motion never
  // reaches it. Capture-phase scroll listener picks up every scrollable
  // ancestor (editor pane, page, anything else) in one binding.
  useEffect(() => {
    if (!visible || !view) return
    let ticking = false
    const recompute = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        const sel = view.state.selection
        if (sel.empty) return
        useFormatStateStore.setState({
          selectionRect: unionCoords(view, sel.from, sel.to),
        })
      })
    }
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [visible, view])

  if (!visible) return null

  const isBold = activeMarks.has('strong')
  const isItalic = activeMarks.has('emphasis')
  const isStrike = activeMarks.has('strike_through')
  const isCode = activeMarks.has('inlineCode')

  const runMark = (markName: string) => () => {
    if (!view) return
    const markType = view.state.schema.marks[markName]
    if (!markType) return
    toggleMark(markType)(view.state, view.dispatch)
    view.focus()
  }

  return (
    <div
      ref={bubbleRef}
      role="toolbar"
      aria-label="Text formatting"
      // onMouseDown.preventDefault: clicking a button would normally
      // shift focus + collapse the selection. We need the selection
      // intact so toggleMark applies to the right range.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        zIndex: 50,
        opacity: pos ? 1 : 0,
        transition: 'opacity 120ms ease',
      }}
      className="flex items-center gap-0.5 rounded-full bg-popover/75 px-1 py-1 shadow-xl shadow-black/30 ring-1 ring-border backdrop-blur-xl"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={runMark('strong')}
        aria-label="Bold"
        aria-pressed={isBold}
        className={cn('h-7 w-7 rounded-lg transition-colors', isBold ? 'bg-accent text-accent-foreground' : 'hover:bg-foreground/10')}
      >
        <IconBold size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={runMark('emphasis')}
        aria-label="Italic"
        aria-pressed={isItalic}
        className={cn('h-7 w-7 rounded-md', isItalic && 'bg-accent text-accent-foreground')}
      >
        <IconItalic size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={runMark('strike_through')}
        aria-label="Strikethrough"
        aria-pressed={isStrike}
        className={cn('h-7 w-7 rounded-md', isStrike && 'bg-accent text-accent-foreground')}
      >
        <IconStrikethrough size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => view && toggleInlineCodeSafe(view)}
        aria-label="Code"
        aria-pressed={isCode}
        className={cn('h-7 w-7 rounded-md', isCode && 'bg-accent text-accent-foreground')}
      >
        <IconCode size={14} stroke={2.25} />
      </Button>
      <LinkButton view={view} active={activeMarks.has('link')} />
    </div>
  )
}

// ── Link ──────────────────────────────────────────────────────────────

/** Read the existing link href that covers any part of the range, so
 * the popover can pre-fill instead of starting from an empty field. */
function readExistingHref(
  view: EditorView,
  range: { from: number; to: number },
): string {
  const linkType = view.state.schema.marks.link
  if (!linkType) return ''
  let href = ''
  view.state.doc.nodesBetween(range.from, range.to, (node) => {
    if (href) return false
    const link = linkType.isInSet(node.marks)
    if (link) {
      href = (link.attrs.href as string) ?? ''
      return false
    }
    return undefined
  })
  return href
}

function LinkButton({ view, active }: { view: EditorView; active: boolean }) {
  const [open, setOpen] = useState(false)
  const [initialUrl, setInitialUrl] = useState('')
  const rangeRef = useRef<{ from: number; to: number } | null>(null)

  const close = () => {
    setOpen(false)
    rangeRef.current = null
    view.focus()
  }

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // The bubble only renders for non-empty selections, so the range
      // is always available — no need to expand-to-word like the old
      // toolbar's LinkButton (which had to handle empty-cursor opens).
      const sel = view.state.selection
      if (sel.empty) return
      const range = { from: sel.from, to: sel.to }
      rangeRef.current = range
      setInitialUrl(readExistingHref(view, range))
      setOpen(true)
    } else {
      close()
    }
  }

  const apply = (href: string) => {
    const range = rangeRef.current
    if (!range) return
    applyLinkMark(view, range, href)
    close()
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Link"
          aria-pressed={active}
          className={cn('h-7 w-7 rounded-md', active && 'bg-accent text-accent-foreground')}
        >
          <IconLink size={14} stroke={2.25} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-2">
        <LinkEditInput initialValue={initialUrl} onApply={apply} onCancel={close} />
      </PopoverContent>
    </Popover>
  )
}
