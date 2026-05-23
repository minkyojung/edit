// Image description editor — opened by right-clicking an image in
// the editor. The image NodeView records the target position +
// viewport rect into `useImageAltDialogStore`; this component mounts
// once at the app root, subscribes to that store, and renders a
// compact Popover anchored to the image.
//
// At save time we *re-resolve* the position rather than trusting the
// `pos` snapshot taken at open time. Collab edits, autosave reloads,
// or fast manual edits can have shifted the position or removed the
// node — we check `doc.nodeAt(pos)` and bail silently when the
// image is gone. The popover stays under the doc-mutation invariants
// the editor already supports.
//
// Anchoring uses the same trick as MarkPopover: an invisible
// fixed-position div sized to the image's rect serves as the
// PopoverAnchor, so Radix positions the popover correctly without
// having to mount anything inside the PM NodeView.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useImageAltDialogStore } from '@/state/imageAltDialogStore'
import { useEditorViewStore } from '@/state/editorViewStore'

function basename(src: string): string {
  const idx = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'))
  return idx >= 0 ? src.slice(idx + 1) : src
}

export function ImageAltDialog() {
  const open = useImageAltDialogStore((s) => s.open)
  const pos = useImageAltDialogStore((s) => s.pos)
  const rect = useImageAltDialogStore((s) => s.rect)
  const initialAlt = useImageAltDialogStore((s) => s.initialAlt)
  const close = useImageAltDialogStore((s) => s.close)

  const [value, setValue] = useState(initialAlt)
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) setValue(initialAlt)
  }, [open, initialAlt])

  useEffect(() => {
    const el = anchorRef.current
    if (!el || !rect) return
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.top}px`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
  }, [rect])

  const srcLabel = useMemo(() => {
    if (!open || pos == null) return ''
    const view = useEditorViewStore.getState().view
    if (!view) return ''
    const node = view.state.doc.nodeAt(pos)
    if (!node || (node.type.name !== 'image' && node.type.name !== 'imageBlock')) return ''
    return basename(String(node.attrs.src ?? ''))
  }, [open, pos])

  const handleSave = () => {
    if (pos == null) {
      close()
      return
    }
    const view = useEditorViewStore.getState().view
    if (!view) {
      close()
      return
    }
    const node = view.state.doc.nodeAt(pos)
    if (!node || (node.type.name !== 'image' && node.type.name !== 'imageBlock')) {
      close()
      return
    }
    if (node.attrs.alt !== value) {
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        alt: value,
      })
      view.dispatch(tr)
    }
    close()
  }

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) close() }}>
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
        className="w-80 gap-2 rounded-xl p-3"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-col gap-0.5">
            <label className="text-xs font-medium text-foreground">
              Description
            </label>
            {srcLabel && (
              <span className="truncate text-[11px] text-muted-foreground">
                {srcLabel}
              </span>
            )}
          </div>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Describe the image"
            className="h-8 text-sm"
          />
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
