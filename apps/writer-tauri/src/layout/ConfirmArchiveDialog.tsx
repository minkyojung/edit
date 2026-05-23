// Confirmation dialog shown before archiving a doc. Always one
// extra click between the user and a cascade-archive — even though
// archive is reversible, surprise removal of a sub-tree from the
// sidebar feels destructive in the moment, and the count gives the
// user a chance to back out if they forgot a child note exists.
//
// Daily entries shouldn't reach this dialog — DocMenu already
// disables the Archive item for them. Defensive guard inside still
// refuses, so a mis-call can't trash the time-axis spine.

import { useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useDocsStore } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { buildViewUrl } from '@/lib/viewUrl'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  slug: string | null
}

export function ConfirmArchiveDialog({ open, onOpenChange, slug }: Props) {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const label = useDocLabel(slug)
  const navigate = useNavigate()

  // Walk the tree to count descendants so the dialog can show the
  // cascade size up front. Already-archived nodes are skipped to
  // mirror collectDescendantSlugs in the store.
  const descendantCount = useMemo(() => {
    if (!slug) return 0
    const queue = [slug]
    const visited = new Set<string>([slug])
    while (queue.length) {
      const parent = queue.shift()!
      for (const d of knownDocs) {
        if (d.parentId === parent && !d.archivedAt && !visited.has(d.slug)) {
          visited.add(d.slug)
          queue.push(d.slug)
        }
      }
    }
    return visited.size - 1
  }, [slug, knownDocs])

  const onConfirm = () => {
    if (!slug) return
    const next = archiveDoc(slug)
    if (next === null) return
    const store = useDocsStore.getState()
    navigate(
      buildViewUrl({
        tab: store.sidebarTab,
        dayAnchor: store.dayAnchor,
        monthAnchor: store.monthAnchor,
        slug: next,
      }),
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Move to Archive?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{label}</span>
            {descendantCount > 0 && (
              <>
                {' '}and {descendantCount} child note
                {descendantCount === 1 ? '' : 's'}
              </>
            )}{' '}
            will be moved to Archive. You can restore later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            Move to Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
