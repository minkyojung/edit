// The single contextual editor menu for a non-empty selection — styling,
// highlighting, and commenting all in ONE modal.
//
//   • Format row (bold / italic / strike / code / link) — always on top.
//   • Below (saved articles only):
//       – selection NOT on a highlight → a "Comment" action that creates one
//       – selection ON a highlight       → the note field + "Remove highlight"
//
// Clicking an existing highlight selects its text (highlightClickPlugin), so
// this same menu opens over it: the format buttons act on the highlighted
// text and the note/remove controls manage it. There is no separate
// highlight popover — one menu, one note field (HighlightNoteField), one
// shell (FLOATING_MENU_SHELL).
//
// Visibility is driven by `useFormatStateStore.selectionEmpty`. Position is
// `position: fixed` and recomputed on selection change + scroll/resize.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toggleMark } from '@milkdown/kit/prose/commands'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  IconBold,
  IconCode,
  IconHighlight,
  IconItalic,
  IconLink,
  IconStrikethrough,
  IconTrash,
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
import { useDocsStore } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import {
  addHighlightRecord,
  getHighlight,
  removeHighlightRecord,
} from '@/lib/highlights'
import { toggleInlineCodeSafe } from './inlineCodeSafe'
import { unionCoords } from './formatStatePlugin'
import { occurrenceIndexAt } from './anchorSearch'
import { LinkEditInput } from './LinkEditInput'
import { applyLinkMark } from './linkUtils'
import { FLOATING_MENU_SHELL } from './floatingMenuShell'
import { HighlightNoteField } from './HighlightNoteField'

/** Vertical gap between the selection's bounding box and the menu. */
const MENU_GAP = 8

/** The proofHighlight id covering the current selection, if any. */
function highlightIdInSelection(view: EditorView): string | null {
  const { from, to } = view.state.selection
  if (from === to) return null
  const markType = view.state.schema.marks.proofHighlight
  if (!markType) return null
  let id: string | null = null
  view.state.doc.nodesBetween(from, to, (node) => {
    if (id) return false
    const m = markType.isInSet(node.marks)
    if (m) {
      id = (m.attrs.id as string) ?? null
      return false
    }
    return undefined
  })
  return id
}

export function SelectionMenu() {
  const view = useEditorViewStore((s) => s.view)
  const selectionEmpty = useFormatStateStore((s) => s.selectionEmpty)
  const selectionRect = useFormatStateStore((s) => s.selectionRect)
  const activeMarks = useFormatStateStore((s) => s.activeMarks)
  // Highlight / comment is a read-it-later feature — only on saved articles.
  const activeSlug = useActiveSlug()
  const isArticle = useDocsStore((s) =>
    activeSlug
      ? s.knownDocs.find((d) => d.slug === activeSlug)?.type === 'article'
      : false,
  )

  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Bridges the create flow: the just-created highlight id, so note mode
  // shows immediately (before the mark repaints into the selection scan).
  const [noteForId, setNoteForId] = useState<string | null>(null)

  const visible = !!view && !selectionEmpty && !!selectionRect

  // Which highlight (if any) the current selection manages, and its record.
  const selId = view ? highlightIdInSelection(view) : null
  const activeId = noteForId ?? selId
  const record =
    activeId && activeSlug ? getHighlight(activeSlug, activeId) : undefined
  const noteMode = !!record

  // Position recompute. useLayoutEffect so the measurement reads after the
  // menu rendered with its actual content but before paint — no one-frame
  // flash at the wrong spot. Re-runs when note mode toggles (menu resizes).
  useLayoutEffect(() => {
    if (!visible || !selectionRect || !menuRef.current) {
      setPos(null)
      return
    }
    const el = menuRef.current
    const w = el.offsetWidth
    const h = el.offsetHeight

    const selCenter = (selectionRect.left + selectionRect.right) / 2
    let left = selCenter - w / 2

    // Default above the selection; flip below if there isn't room.
    let top = selectionRect.top - h - MENU_GAP
    if (top < 8) top = selectionRect.bottom + MENU_GAP

    const maxLeft = window.innerWidth - w - 8
    left = Math.max(8, Math.min(left, maxLeft))

    setPos({ top, left })
  }, [visible, selectionRect, noteMode])

  // Follow the selection as the user scrolls / resizes. The plugin only
  // fires on transactions, so scroll-only motion never reaches it.
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

  // The create-flow bridge is only meaningful while the menu is open.
  useEffect(() => {
    if (!visible) setNoteForId(null)
  }, [visible])

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
    // In note mode the note input holds focus — toggleMark works on the
    // stored selection regardless, so don't yank focus back to the editor
    // (that would blur-commit + close the menu).
    if (!noteMode) view.focus()
  }

  // Create a highlight over the current selection, then drop into note mode
  // (the format row stays; the note field appears below). The mark is
  // painted reactively by useHighlightMarks; noteForId surfaces the note
  // field immediately without waiting for that repaint.
  const createHighlight = () => {
    if (!view || !activeSlug) return
    const { from, to } = view.state.selection
    if (from === to) return
    const quote = view.state.doc.textBetween(from, to, '\n', '\n')
    const id = crypto.randomUUID()
    addHighlightRecord(activeSlug, {
      id,
      quote,
      occurrence: occurrenceIndexAt(view.state.doc, quote, from),
      createdAt: new Date().toISOString(),
    })
    setNoteForId(id)
  }

  // Leave note mode / dismiss by collapsing the selection to its end
  // (selectionEmpty → menu hides), returning focus to the editor.
  const dismiss = () => {
    const to = view?.state.selection.to ?? null
    setNoteForId(null)
    if (view && to != null) {
      const caret = Math.min(to, view.state.doc.content.size)
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)),
      )
      view.focus()
    }
  }

  const remove = () => {
    if (!activeSlug || !activeId) return
    removeHighlightRecord(activeSlug, activeId)
    dismiss()
  }

  const docTitle =
    (activeSlug &&
      useDocsStore.getState().knownDocs.find((d) => d.slug === activeSlug)
        ?.title) ||
    ''

  const fmtBtn = 'h-7 w-7 rounded-md transition-colors'
  const fmtActive = 'bg-accent text-accent-foreground'
  const fmtIdle = 'hover:bg-foreground/15 dark:hover:bg-foreground/15'

  return (
    <div
      ref={menuRef}
      role="toolbar"
      aria-label="Selection actions"
      // mousedown.preventDefault keeps focus where it is (selection in the
      // editor, or the note input in note mode) so clicking a button doesn't
      // collapse the selection / blur-commit the note before it runs.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        zIndex: 50,
        opacity: pos ? 1 : 0,
        transition: 'opacity 120ms ease',
      }}
      className={cn(
        FLOATING_MENU_SHELL,
        'flex flex-col gap-1',
        noteMode ? 'w-72' : 'w-max',
      )}
    >
      {/* Format section — always visible. */}
      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" onClick={runMark('strong')} aria-label="Bold" aria-pressed={isBold} className={cn(fmtBtn, isBold ? fmtActive : fmtIdle)}>
          <IconBold size={14} stroke={2.25} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={runMark('emphasis')} aria-label="Italic" aria-pressed={isItalic} className={cn(fmtBtn, isItalic ? fmtActive : fmtIdle)}>
          <IconItalic size={14} stroke={2.25} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={runMark('strike_through')} aria-label="Strikethrough" aria-pressed={isStrike} className={cn(fmtBtn, isStrike ? fmtActive : fmtIdle)}>
          <IconStrikethrough size={14} stroke={2.25} />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => view && toggleInlineCodeSafe(view)} aria-label="Code" aria-pressed={isCode} className={cn(fmtBtn, isCode ? fmtActive : fmtIdle)}>
          <IconCode size={14} stroke={2.25} />
        </Button>
        <LinkButton view={view} active={activeMarks.has('link')} />
      </div>

      {/* Comment / highlight management (saved articles only). */}
      {isArticle && (
        <>
          <div className="mx-1 h-px bg-border" />
          {noteMode && record ? (
            <>
              <HighlightNoteField
                key={activeId!}
                slug={activeSlug!}
                id={activeId!}
                quote={record.quote}
                initialNote={record.note ?? ''}
                hadNote={!!record.note}
                title={docTitle}
                onClose={dismiss}
              />
              <button
                type="button"
                // preventDefault keeps the note input focused so this doesn't
                // blur-commit the note before onClick.
                onMouseDown={(e) => e.preventDefault()}
                onClick={remove}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-destructive transition-colors',
                  'hover:bg-destructive/10',
                )}
              >
                <IconTrash size={15} stroke={1.9} className="shrink-0" />
                <span className="flex-1">Remove highlight</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={createHighlight}
              className={cn(
                // rounded-lg (8px) = outer rounded-xl (12px) − p-1 (4px), so
                // the row's hover fill nests concentrically in the menu.
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                fmtIdle,
              )}
            >
              <IconHighlight size={15} stroke={1.9} className="shrink-0" />
              <span className="flex-1">Comment</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Link ──────────────────────────────────────────────────────────────

/** Read the existing link href that covers any part of the range, so the
 * popover can pre-fill instead of starting from an empty field. */
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
          className={cn('h-7 w-7 rounded-md transition-colors', active ? 'bg-accent text-accent-foreground' : 'hover:bg-foreground/15 dark:hover:bg-foreground/15')}
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
