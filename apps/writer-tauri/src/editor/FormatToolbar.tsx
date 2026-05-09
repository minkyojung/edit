// Static formatting toolbar that lives in the editor's Row 2 slot.
//
// Phase 1 minimum: Style dropdown (block transforms) + Bold + Italic.
// Active-state visualization (this commit) reflects the live cursor
// position so the user sees what's "on" before clicking. The Link
// button arrives in Step 12.
//
// Why call ProseMirror commands directly instead of going through
// Milkdown's commandsCtx: the rest of writer-tauri (markActions.ts,
// useApplyPendingMarks.ts) already operates on the EditorView via
// PM transactions and reads schema types straight off view.state. We
// stay in that lane for consistency — and because the commonmark
// preset registered the marks/nodes by the names we look up below, no
// Milkdown ctx is needed to run setBlockType / wrapIn / wrapInList.

import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconBold, IconChevronDown, IconItalic } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

  /** Highlight the dropdown row that matches the current block so
   * the user sees "this is what I'm in" alongside the trigger label. */
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
    </div>
  )
}
