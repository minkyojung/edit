// Doc-level action menu for the editor header. The `⋯` trigger sits
// in the rightmost slot of EditorHeader and reveals a small dropdown
// of doc-scoped actions: Document info (read-only stats) and Delete
// (move to the OS trash, recoverable). Daily entries
// disable Delete since they're the time-axis spine.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl } from '@/lib/viewUrl'
import { DocumentInfoDialog } from './DocumentInfoDialog'

interface Props {
  editorView: EditorView | null
}

export function DocMenu({ editorView }: Props) {
  const activeSlug = useActiveSlug()
  const activeDoc = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug) : null,
  )
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const navigate = useNavigate()
  const [infoOpen, setInfoOpen] = useState(false)

  const disabled = !activeSlug
  // Daily entries are the time-axis spine; deleting them would tear
  // the breadcrumb anchor out from under their child notes. The
  // store also refuses, but keep the menu honest.
  const deleteDisabled = !activeDoc || activeDoc.type === 'daily'

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
                className={cn(
                  'cursor-pointer text-sidebar-foreground/60 hover:text-sidebar-foreground',
                )}
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
            disabled={deleteDisabled}
            onSelect={() => {
              if (!activeSlug) return
              void deleteToTrash(activeSlug).then((next) => {
                if (next) {
                  const store = useDocsStore.getState()
                  navigate(
                    buildViewUrl({
                      tab: store.sidebarTab,
                      dayAnchor: store.dayAnchor,
                      monthAnchor: store.monthAnchor,
                      slug: next,
                    }),
                  )
                }
              })
            }}
            className={cn('text-destructive focus:text-destructive')}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DocumentInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        editorView={editorView}
      />
    </>
  )
}
