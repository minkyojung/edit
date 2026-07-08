// Editor-header action menu. The trigger sits in the rightmost slot of
// EditorHeader and reveals a small dropdown of doc-scoped actions (Document
// info, Delete). Daily entries disable Delete since they're the time-axis
// spine.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconDots } from '@tabler/icons-react'
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
import { isAgentAssetPath, deleteAssetByPath } from '@/lib/deleteAsset'
import { confirm } from '@/state/confirmStore'
import { DocumentInfoDialog } from './DocumentInfoDialog'

export function DocMenu() {
  const activeSlug = useActiveSlug()
  const activeDoc = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug) : null,
  )
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const navigate = useNavigate()
  const [infoOpen, setInfoOpen] = useState(false)

  // Daily entries are the time-axis spine; deleting them would tear the
  // breadcrumb anchor out from under their child notes. The store also
  // refuses, but keep the menu honest.
  const deleteDisabled = !activeDoc || activeDoc.type === 'daily'

  // Delete the active doc. Skills / routines / agents route through the shared
  // asset-delete path (folder-aware for skills, tombstoned so seeded defaults
  // don't resurrect); every other note is a plain trash. Both ask first.
  const navigateTo = (slug: string) => {
    const store = useDocsStore.getState()
    navigate(
      buildViewUrl({
        tab: store.sidebarTab,
        dayAnchor: store.dayAnchor,
        monthAnchor: store.monthAnchor,
        slug,
      }),
    )
  }
  const handleDelete = async () => {
    if (!activeSlug || !activeDoc) return
    const rel = activeDoc.relPath
    if (rel && isAgentAssetPath(rel)) {
      const ok = await confirm({
        title: `Delete “${activeDoc.title || rel}”?`,
        description: 'This cannot be undone.',
      })
      if (!ok) return
      await deleteAssetByPath(rel)
      const next = useDocsStore.getState().openSlugs[0]
      if (next) navigateTo(next)
      return
    }
    const next = await deleteToTrash(activeSlug)
    if (next) navigateTo(next)
  }

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="iconGhost"
                size="icon-sm"
                aria-label="More"
                className="cursor-pointer"
              >
                <IconDots size={16} stroke={1.75} />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} className="w-56">
          <DropdownMenuItem disabled={!activeSlug} onSelect={() => setInfoOpen(true)}>
            Document info
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={deleteDisabled}
            onSelect={() => void handleDelete()}
            className={cn('text-destructive focus:text-destructive')}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DocumentInfoDialog open={infoOpen} onOpenChange={setInfoOpen} />
    </>
  )
}
