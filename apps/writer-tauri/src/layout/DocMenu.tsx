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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'
import { useDocsStore } from '@/state/docsStore'
import { exportPage } from '@/export/exportPage'
import { DocumentInfoDialog } from './DocumentInfoDialog'
import { ConfirmArchiveDialog } from './ConfirmArchiveDialog'

interface Props {
  editorView: EditorView | null
}

/**
 * Glue between the menu item and the exportPage flow. Lives at module
 * scope (not inside the component) so the onSelect handler can fire
 * the async work without dragging React state into the await chain —
 * the dropdown closes immediately, the user sees the native save
 * dialog, and the toast appears whenever the OS-level write settles.
 *
 * Silent on 'cancelled' (the user explicitly dismissed the save
 * dialog — toasting that would feel like nagging); louder on anything
 * else.
 */
async function runExport(slug: string, title?: string): Promise<void> {
  const result = await exportPage(slug, title)
  if (result.ok && result.filePath) {
    notify.exportPageOk({
      filePath: result.filePath,
      marksExported: result.marksExported,
    })
    return
  }
  if (result.reason === 'cancelled') return
  if (result.reason === 'empty') {
    notify.exportPageEmpty()
    return
  }
  notify.exportPageFailed()
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
            disabled={!activeSlug}
            onSelect={() => {
              // Fire-and-forget: the save dialog runs async on the
              // native side, and any errors route through notify.* so
              // we don't need to await here (and shouldn't — leaving
              // it pending blocks the dropdown's close animation).
              if (!activeSlug) return
              void runExport(activeSlug, activeDoc?.title)
            }}
          >
            Export as Markdown
          </DropdownMenuItem>

          <DropdownMenuSeparator />

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
