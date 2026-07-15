// Editor-header action menu. The trigger sits in the rightmost slot of
// EditorHeader and reveals a small dropdown of doc-scoped actions (Document
// info, Delete). Daily entries disable Delete since they're the time-axis
// spine.

import { useState } from 'react'
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
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useDocsStore } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { openDoc } from '@/lib/openDoc'
import { isAgentAssetPath, deleteAssetByPath } from '@/lib/deleteAsset'
import { copyAsRichText } from '@/lib/copyAsRichText'
import { confirm } from '@/state/confirmStore'
import { DocumentInfoDialog } from './DocumentInfoDialog'

export function DocMenu() {
  const activeSlug = useActiveSlug()
  const activeDoc = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug) : null,
  )
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const [infoOpen, setInfoOpen] = useState(false)

  // Daily entries are the time-axis spine; deleting them would tear the
  // breadcrumb anchor out from under their child notes. The store also
  // refuses, but keep the menu honest.
  const deleteDisabled = !activeDoc || activeDoc.type === 'daily'

  // Delete the active doc. Skills / commands / agents route through the shared
  // asset-delete path (folder-aware for skills, tombstoned so seeded defaults
  // don't resurrect); every other note is a plain trash. Both ask first.
  const navigateTo = (slug: string) => {
    openDoc(slug)
  }
  // Copy the whole note to the clipboard with its formatting intact, so
  // pasting into an external rich editor (Substack, Notion, Docs) keeps
  // headings / bullets / bold rather than dumping raw markdown source.
  // Reads the live body cache — the CM change listener keeps it current.
  const handleCopyRichText = async () => {
    if (!activeSlug) return
    const md = useDocsStore.getState().handles[activeSlug]?.bodyMarkdown ?? ''
    if (!md.trim()) {
      toast.info('Nothing to copy')
      return
    }
    const rich = await copyAsRichText(md)
    toast.success(rich ? 'Copied with formatting' : 'Copied as text')
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
            disabled={!activeSlug}
            onSelect={() => void handleCopyRichText()}
          >
            Copy as rich text
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
