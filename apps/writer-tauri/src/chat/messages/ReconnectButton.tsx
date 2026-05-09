import { useConnectDialog } from '@/stores/connectDialog'

/** Reconnect button. Surfaced inside the destructive footer when a chat
 * turn fails with `errorCode === 'AUTH'` — clicking opens the Claude OAuth
 * dialog (same one the sidebar account menu uses) so the user can re-auth
 * without leaving the conversation. */
export function ReconnectButton() {
  const setOpen = useConnectDialog((s) => s.setOpen)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive transition-colors shrink-0 outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring/40"
      title="Reconnect to Claude"
    >
      <span className="font-medium">Reconnect</span>
    </button>
  )
}
