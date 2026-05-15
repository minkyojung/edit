// Doc-level action menu for the editor header. The `⋯` trigger sits
// in the rightmost slot of EditorHeader and reveals a small dropdown
// of doc-scoped actions: Document info (read-only stats) and
// Archive (soft-delete with cascade + confirm). Daily entries
// disable Archive since they're the time-axis spine.

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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { DocumentInfoDialog } from './DocumentInfoDialog'
import { ConfirmArchiveDialog } from './ConfirmArchiveDialog'

interface Props {
  editorView: EditorView | null
}

export function DocMenu({ editorView }: Props) {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const handle = useDocsStore((s) => (activeSlug ? s.handles[activeSlug] : null))
  const activeDoc = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug) : null,
  )
  const [infoOpen, setInfoOpen] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)

  const disabled = !activeSlug
  // Daily entries are the time-axis spine; archiving them would tear
  // the breadcrumb anchor out from under their child notes. The
  // store also refuses, but keep the menu honest.
  const archiveDisabled = !activeDoc || activeDoc.type === 'daily'

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
          <DropdownMenuItem onSelect={() => setInfoOpen(true)}>
            Document info
          </DropdownMenuItem>

          <DropdownMenuItem
            disabled={archiveDisabled}
            onSelect={() => setArchiveConfirmOpen(true)}
            className={cn('text-destructive focus:text-destructive')}
          >
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DocumentInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        ydoc={handle?.ydoc ?? null}
        editorView={editorView}
      />

      <ConfirmArchiveDialog
        open={archiveConfirmOpen}
        onOpenChange={setArchiveConfirmOpen}
        slug={activeSlug}
      />
    </>
  )
}
