// Static formatting toolbar that lives in the editor's Row 2 slot.
//
// Phase 1 minimum: Style dropdown (block transforms) + Bold + Italic.
// No active-state visualization yet (Step 11) and no Link button yet
// (Step 12) — both arrive in follow-ups so this commit only delivers
// "click does the thing" behavior.
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
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEditorViewStore } from '@/state/editorViewStore'

export function FormatToolbar() {
  const view = useEditorViewStore((s) => s.view)
  const disabled = !view

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
            Style
            <IconChevronDown size={12} stroke={2} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={runBlock(setText)}>Text</DropdownMenuItem>
          <DropdownMenuItem onSelect={runBlock(setHeading(1))}>Heading 1</DropdownMenuItem>
          <DropdownMenuItem onSelect={runBlock(setHeading(2))}>Heading 2</DropdownMenuItem>
          <DropdownMenuItem onSelect={runBlock(setHeading(3))}>Heading 3</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={runBlock(wrapBullet)}>Bullet list</DropdownMenuItem>
          <DropdownMenuItem onSelect={runBlock(wrapNumbered)}>Numbered list</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={runBlock(wrapQuote)}>Quote</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="!h-4 mx-1" />

      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={runMark('strong')}
        aria-label="Bold"
        className="h-7 w-7"
      >
        <IconBold size={14} stroke={2.25} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        onClick={runMark('emphasis')}
        aria-label="Italic"
        className="h-7 w-7"
      >
        <IconItalic size={14} stroke={2.25} />
      </Button>
    </div>
  )
}
