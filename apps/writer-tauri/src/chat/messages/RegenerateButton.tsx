import { IconRefresh } from '@tabler/icons-react'

/** Regenerate button. Replaces the assistant turn with a fresh run against
 * the same prior history. Shown only on the most-recent settled assistant
 * turn — see ChatPanel's `regeneratableTurnId` for why. */
export function RegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Regenerate response"
      title="Regenerate"
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <IconRefresh size={14} />
    </button>
  )
}
