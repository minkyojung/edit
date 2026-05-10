// Floating bar that surfaces Open / Remove for the link the cursor
// is hovering. Appears 300ms after hover starts (driven by
// linkHoverPlugin), persists while the cursor is over the link or
// the bar itself, fades 150ms after both are left.

import { useEffect, useState } from 'react'
import { IconExternalLink, IconUnlink } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useLinkHoverStore } from '@/state/linkHoverStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import {
  keepLinkHoverAlive,
  releaseLinkHoverAlive,
} from './linkHoverPlugin'
import { openLinkSafely } from './linkUtils'

// 0px so the bar's hit area sits flush with the link's bottom edge.
// Visual separation comes from padding-top on the bar itself —
// connecting the hit area is what kills the dead zone.
const GAP_PX = 0
const BAR_PAD_TOP_PX = 8

function shortHostname(href: string): string {
  try {
    const u = new URL(href)
    if (u.protocol === 'mailto:') return u.pathname || href
    return u.hostname.replace(/^www\./, '')
  } catch {
    return href
  }
}

export function LinkHoverBar() {
  const active = useLinkHoverStore((s) => s.active)
  const view = useEditorViewStore((s) => s.view)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Recompute position whenever active changes, and re-align on
  // scroll/resize so the bar tracks the link as the editor moves.
  useEffect(() => {
    if (!active) {
      setPos(null)
      return
    }
    const update = () => {
      const rect = active.anchor.getBoundingClientRect()
      // Anchor scrolled out of view → close.
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        useLinkHoverStore.getState().setActive(null)
        return
      }
      setPos({ top: rect.bottom + GAP_PX, left: rect.left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [active])

  if (!active || !pos) return null

  const close = () => {
    releaseLinkHoverAlive()
    useLinkHoverStore.getState().setActive(null)
  }

  const handleOpen = () => {
    openLinkSafely(active.href)
    close()
  }

  const handleRemove = () => {
    if (!view) return
    const linkType = view.state.schema.marks.link
    if (!linkType) return
    view.dispatch(view.state.tr.removeMark(active.from, active.to, linkType))
    close()
  }

  return (
    // Outer wrapper carries the hover handlers and a transparent
    // padding-top that bridges the visual gap to the link, so the
    // cursor never crosses a dead zone on its way down.
    <div
      onMouseEnter={keepLinkHoverAlive}
      onMouseLeave={close}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        paddingTop: BAR_PAD_TOP_PX,
        zIndex: 50,
      }}
    >
      <div
        role="toolbar"
        aria-label="Link actions"
        className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpen}
          className="h-7 gap-1.5 px-2 text-[12px] font-medium"
          title={active.href}
        >
          <IconExternalLink size={13} stroke={2} />
          <span className="max-w-[180px] truncate">{shortHostname(active.href)}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={handleRemove}
          aria-label="Remove link"
          className="h-7 w-7"
        >
          <IconUnlink size={13} stroke={2} />
        </Button>
      </div>
    </div>
  )
}
