// Onboarding step — You're all set (completion).
//
// The last panel: the folder is chosen, so this confirms and hands off to the
// editor. Pure view — the real launcher opens the project window on "Open
// Octave"; the /onboard design-preview renders it with a no-op.

import { Button } from '@/components/ui/button'

interface Props {
  onEnter: () => void
  /** Disable the action while the project window is opening — prevents a
   * double-click from spawning two windows across the async gap. */
  busy?: boolean
  /** Set when the previous open attempt failed, so the user can retry
   * instead of being stranded with a button that silently did nothing. */
  error?: string | null
}

export function DonePanel({ onEnter, busy, error }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + action */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          You&apos;re all set
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Your vault is ready. Octave will open it in a fresh window — a welcome
          note is waiting to show you around. Start writing whenever you like.
        </p>
        <Button className="w-fit px-8" onClick={onEnter} disabled={busy}>
          {busy ? 'Opening…' : 'Open Octave'}
        </Button>
        {error && <p className="mt-3 text-footnote text-destructive">{error}</p>}
      </div>

      {/* Right: preview panel (placeholder — swap for a real image later) */}
      <div className="flex items-center justify-center p-4">
        <div className="flex h-full w-full items-center justify-center rounded-2xl bg-gradient-to-br from-muted/60 to-muted/20">
          <span className="text-footnote text-muted-foreground/60">Preview image</span>
        </div>
      </div>
    </div>
  )
}
