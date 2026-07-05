// Single host for the imperative confirm dialog (see state/confirmStore).
// Mounted once at app root; renders whatever the latest `confirm(...)` asked
// for and settles its promise on the user's choice.

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useConfirmStore } from '@/state/confirmStore'

export function ConfirmDialogHost() {
  const open = useConfirmStore((s) => s.open)
  const options = useConfirmStore((s) => s.options)
  const settle = useConfirmStore((s) => s.settle)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) settle(false) }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          {options?.description ? (
            <DialogDescription>{options.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            variant={options?.destructive === false ? 'default' : 'destructive'}
            onClick={() => settle(true)}
          >
            {options?.confirmLabel ?? 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
