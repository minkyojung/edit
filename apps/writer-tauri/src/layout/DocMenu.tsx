// Editor-header action menu. The trigger sits in the rightmost slot of
// EditorHeader and reveals a small dropdown. Top: "Organize" actions — file
// content into the wiki/daily via the general intake agent (today + inbox, or
// just the open note). Bottom: doc-scoped actions (Document info, Delete).
// Daily entries disable Delete since they're the time-axis spine.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconDots, IconLoader2 } from '@tabler/icons-react'
import { toast } from 'sonner'
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
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl } from '@/lib/viewUrl'
import { organizeTodayAndInbox, buildOrganizeNoteRequest } from '@/agent/organize'
import { usePendingOrganize } from '@/state/pendingOrganizeStore'
import { isAgentAssetPath, deleteAssetByPath } from '@/lib/deleteAsset'
import { confirm } from '@/state/confirmStore'
import { DocumentInfoDialog } from './DocumentInfoDialog'

export function DocMenu() {
  const activeSlug = useActiveSlug()
  const activeDoc = useDocsStore((s) =>
    activeSlug ? s.knownDocs.find((d) => d.slug === activeSlug) : null,
  )
  const deleteToTrash = useDocsStore((s) => s.deleteToTrash)
  const setOrganizeRequest = usePendingOrganize((s) => s.setRequest)
  const navigate = useNavigate()
  const [infoOpen, setInfoOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Daily entries are the time-axis spine; deleting them would tear the
  // breadcrumb anchor out from under their child notes. The store also
  // refuses, but keep the menu honest.
  const deleteDisabled = !activeDoc || activeDoc.type === 'daily'

  const organizeAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { processed, proposals } = await organizeTodayAndInbox()
      if (processed === 0) toast.info('Nothing to organize')
      else if (proposals === 0) toast.info('Organized — nothing new to file')
      else
        toast.success(
          `Organized ${processed} note${processed === 1 ? '' : 's'} — ${proposals} to review`,
        )
    } catch (err) {
      console.warn('[organize] today + inbox failed', err)
      toast.error('Organize failed')
    } finally {
      setBusy(false)
    }
  }

  // "Organize this note" opens a visible chat thread instead of running
  // headless: record the intent here, and the chat components (RightPanel +
  // ChatPanel) create the thread and stream the run. The agent's reading /
  // proposing is then watchable like any other conversation.
  const organizeThis = async () => {
    if (!activeSlug) return
    const req = await buildOrganizeNoteRequest(activeSlug)
    if (!req) {
      toast.error('Organize failed')
      return
    }
    setOrganizeRequest(req)
  }

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
                disabled={busy}
                aria-label="More"
                className="cursor-pointer"
              >
                {busy ? (
                  <IconLoader2 size={16} stroke={1.75} className="animate-spin" />
                ) : (
                  <IconDots size={16} stroke={1.75} />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">More</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} className="w-56">
          <DropdownMenuItem disabled={busy} onSelect={() => void organizeAll()}>
            Organize today + inbox
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy || !activeSlug}
            onSelect={() => organizeThis()}
          >
            Organize this note
          </DropdownMenuItem>

          <DropdownMenuSeparator />

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
