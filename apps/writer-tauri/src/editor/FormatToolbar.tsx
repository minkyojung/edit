// Static formatting toolbar that lives in the editor's Row 2 slot.
//
// Phase 1 minimum: Style dropdown (block transforms) + Bold + Italic
// + Link. The toolbar mirrors the cursor's active block and inline
// marks via formatStateStore so toggles read as on/off without the
// user having to click to discover state.
//
// Why call ProseMirror commands directly instead of going through
// Milkdown's commandsCtx: the rest of writer-tauri (markActions.ts,
// useApplyPendingMarks.ts) already operates on the EditorView via
// PM transactions and reads schema types straight off view.state. We
// stay in that lane for consistency — and because the commonmark
// preset registered the marks/nodes by the names we look up below, no
// Milkdown ctx is needed to run setBlockType / wrapIn / wrapInList.

import { useEffect, useRef, useState } from 'react'
import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  IconBold,
  IconChevronDown,
  IconCode,
  IconItalic,
  IconLink,
  IconStrikethrough,
} from '@tabler/icons-react'

import { toggleInlineCodeSafe } from './inlineCodeSafe'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useEditorViewStore } from '@/state/editorViewStore'
import {
  useFormatStateStore,
  type FormatBlockType,
} from '@/state/formatStateStore'
import { cn } from '@/lib/utils'

const STYLE_LABEL: Record<FormatBlockType, string> = {
  paragraph: 'Text',
  'heading-1': 'Heading 1',
  'heading-2': 'Heading 2',
  'heading-3': 'Heading 3',
  'heading-4': 'Heading 4',
  'heading-5': 'Heading 5',
  'heading-6': 'Heading 6',
  bullet_list: 'Bullet list',
  ordered_list: 'Numbered list',
  blockquote: 'Quote',
  code_block: 'Code',
  unknown: 'Style',
}

export function FormatToolbar() {
  const view = useEditorViewStore((s) => s.view)
  const blockType = useFormatStateStore((s) => s.blockType)
  const activeMarks = useFormatStateStore((s) => s.activeMarks)
  const disabled = !view

  const isBold = activeMarks.has('strong')
  const isItalic = activeMarks.has('emphasis')
  const isStrike = activeMarks.has('strike_through')
  const isCode = activeMarks.has('inlineCode')
  const isLink = activeMarks.has('link')

  const runMark = (markName: string) => () => {
    if (!view) return
    const markType = view.state.schema.marks[markName]
    if (!markType) return
    toggleMark(markType)(view.state, view.dispatch)
    view.focus()
  }

  const runBlock = (op: (view: EditorView) => void) => () => {
    if (!view) return
    op(view)
    view.focus()
  }

  const setText = (v: EditorView) => {
    const t = v.state.schema.nodes.paragraph
    if (t) setBlockType(t)(v.state, v.dispatch)
  }
  const setHeading = (level: number) => (v: EditorView) => {
    const t = v.state.schema.nodes.heading
    if (t) setBlockType(t, { level })(v.state, v.dispatch)
  }
  const wrapBullet = (v: EditorView) => {
    const t = v.state.schema.nodes.bullet_list
    if (t) wrapInList(t)(v.state, v.dispatch)
  }
  const wrapNumbered = (v: EditorView) => {
    const t = v.state.schema.nodes.ordered_list
    if (t) wrapInList(t)(v.state, v.dispatch)
  }
  const wrapQuote = (v: EditorView) => {
    const t = v.state.schema.nodes.blockquote
    if (t) wrapIn(t)(v.state, v.dispatch)
  }

  const itemActive = (target: FormatBlockType) =>
    blockType === target ? 'bg-accent text-accent-foreground' : undefined

  return (
    <div className="flex h-full items-center gap-1 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-7 gap-1 px-2 text-[13px] font-medium"
          >
            {STYLE_LABEL[blockType]}
            <IconChevronDown size={12} stroke={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem
            onSelect={runBlock(setText)}
            className={itemActive('paragraph')}
          >
            Text
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={runBlock(setHeading(1))}
            className={itemActive('heading-1')}
          >
            Heading 1
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={runBlock(setHeading(2))}
            className={itemActive('heading-2')}
          >
            Heading 2
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={runBlock(setHeading(3))}
            className={itemActive('heading-3')}
          >
            Heading 3
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={runBlock(wrapBullet)}
            className={itemActive('bullet_list')}
          >
            Bullet list
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={runBlock(wrapNumbered)}
            className={itemActive('ordered_list')}
          >
            Numbered list
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={runBlock(wrapQuote)}
            className={itemActive('blockquote')}
          >
            Quote
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Vertical divider — drawn directly instead of using shadcn's
          Separator because the primitive hardcodes data-vertical:self-
          stretch, which beats both items-center on the parent and any
          self-center we add (variant selectors win on specificity). */}
      <div aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-border" />

      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={runMark('strong')}
        aria-label="Bold"
        aria-pressed={isBold}
        className={cn('h-7 w-7', isBold && 'bg-accent text-accent-foreground')}
      >
        <IconBold size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={runMark('emphasis')}
        aria-label="Italic"
        aria-pressed={isItalic}
        className={cn('h-7 w-7', isItalic && 'bg-accent text-accent-foreground')}
      >
        <IconItalic size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={runMark('strike_through')}
        aria-label="Strikethrough"
        aria-pressed={isStrike}
        className={cn('h-7 w-7', isStrike && 'bg-accent text-accent-foreground')}
      >
        <IconStrikethrough size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={() => view && toggleInlineCodeSafe(view)}
        aria-label="Code"
        aria-pressed={isCode}
        className={cn('h-7 w-7', isCode && 'bg-accent text-accent-foreground')}
      >
        <IconCode size={14} stroke={2.25} />
      </Button>

      <div aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-border" />

      <LinkButton view={view} active={isLink} disabled={disabled} />
    </div>
  )
}

// ── Link ──────────────────────────────────────────────────────────────

/** Walk left and right from the cursor to the surrounding word's
 * boundaries (whitespace or text-block edge). Returns null when the
 * cursor sits on whitespace and there's no word to expand to —
 * callers treat that as "do nothing." Unicode-aware so words in
 * Korean / emoji / Latin all behave the same way. */
function expandToWord(view: EditorView): { from: number; to: number } | null {
  const sel = view.state.selection
  if (!sel.empty) return { from: sel.from, to: sel.to }

  const $pos = sel.$from
  const parent = $pos.parent
  if (!parent.isTextblock) return null

  const text = parent.textContent
  const offset = $pos.parentOffset
  const wordChar = /[\p{L}\p{N}_]/u

  let start = offset
  let end = offset
  while (start > 0 && wordChar.test(text[start - 1])) start--
  while (end < text.length && wordChar.test(text[end])) end++

  if (start === end) return null

  const blockStart = $pos.start()
  return { from: blockStart + start, to: blockStart + end }
}

/** Read the existing link href that covers (any part of) the range,
 * if any. Used to pre-fill the popover so editing an existing link
 * shows its current URL instead of an empty field. */
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

interface LinkButtonProps {
  view: EditorView | null
  active: boolean
  disabled: boolean
}

function LinkButton({ view, active, disabled }: LinkButtonProps) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const rangeRef = useRef<{ from: number; to: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Autofocus the input when the popover opens. Radix's Popover steals
  // focus on open, so we delay one tick to win the focus race.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (next) {
      if (!view) return
      const range = expandToWord(view)
      if (!range) return // cursor on whitespace with no word — silent no-op
      rangeRef.current = range
      setUrl(readExistingHref(view, range))
      setOpen(true)
    } else {
      setOpen(false)
      setUrl('')
      rangeRef.current = null
      view?.focus()
    }
  }

  const apply = () => {
    if (!view) return
    const range = rangeRef.current
    if (!range) return
    const linkType = view.state.schema.marks.link
    if (!linkType) return

    const href = url.trim()
    const tr = view.state.tr.removeMark(range.from, range.to, linkType)
    if (href) {
      tr.addMark(range.from, range.to, linkType.create({ href }))
    }
    view.dispatch(tr)
    handleOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label="Link"
          aria-pressed={active}
          className={cn('h-7 w-7', active && 'bg-accent text-accent-foreground')}
        >
          <IconLink size={14} stroke={2.25} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-2">
        <Input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              handleOpenChange(false)
            }
          }}
          placeholder="https://…"
          className="h-8 px-3 text-sm"
        />
      </PopoverContent>
    </Popover>
  )
}
