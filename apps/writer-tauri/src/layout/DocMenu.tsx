// Doc-level action menu for the editor header. The `⋯` trigger sits
// in the rightmost slot of EditorHeader and reveals a small dropdown
// of doc-scoped actions (export, duplicate, delete, info).
//
// Most items are placeholders for now — they render and are findable
// but the underlying actions need plumbing (Milkdown markdown
// serializer access, Tauri save dialogs, server delete API). They're
// disabled with reduced opacity so users can see the future menu
// shape without expecting them to work yet.
//
// The Document Info item is fully wired: it pulls live word/char
// counts from the active editor view and AI-mark counts from the
// ydoc, and renders them in a small dialog.

import { useState } from 'react'
import { IconDots } from '@tabler/icons-react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { DocumentInfoDialog } from './DocumentInfoDialog'

interface Props {
  editorView: EditorView | null
}

export function DocMenu({ editorView }: Props) {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handle = useDocsStore((s) => (activeSlug ? s.handles[activeSlug] : null))
  const [infoOpen, setInfoOpen] = useState(false)

  const disabled = !activeSlug

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label="Document actions"
                className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              >
                <IconDots size={16} stroke={1.75} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More actions</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} className="w-52">
          <DropdownMenuItem disabled className={comingSoonClass}>
            Copy as Markdown
            <ComingSoon />
          </DropdownMenuItem>
          <DropdownMenuItem disabled className={comingSoonClass}>
            Export as Markdown…
            <ComingSoon />
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem disabled className={comingSoonClass}>
            Duplicate
            <ComingSoon />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setInfoOpen(true)}>
            Document info
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            disabled
            className={cn(comingSoonClass, 'text-destructive focus:text-destructive')}
          >
            Delete
            <ComingSoon />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DocumentInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        ydoc={handle?.ydoc ?? null}
        editorView={editorView}
      />
    </>
  )
}

const comingSoonClass = 'justify-between'

function ComingSoon() {
  return (
    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
      Soon
    </span>
  )
}
