import { IconPlugConnected } from '@tabler/icons-react'
import { useConnectDialog } from '@/stores/connectDialog'

/** Reconnect button. Surfaced in the error card when a chat turn fails with
 * `errorCode === 'AUTH'` — clicking opens the Claude OAuth dialog (same one
 * the sidebar account menu uses) so the user can re-auth without leaving the
 * conversation. Shares the Retry button's shape/size so the error card's
 * actions read as one family. */
export function ReconnectButton() {
  const setOpen = useConnectDialog((s) => s.setOpen)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-body font-medium text-destructive transition-colors outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40"
      title="Reconnect to Claude"
    >
      <IconPlugConnected size={14} />
      <span>Reconnect</span>
    </button>
  )
}
