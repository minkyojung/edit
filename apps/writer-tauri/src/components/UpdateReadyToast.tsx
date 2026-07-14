// The update-ready toast: three actions — See changes / Restart when idle /
// Restart. sonner's default toast supports only one action + one cancel, so
// this is a `toast.custom` render (our own JSX, styled like the app toaster).
// Shown when a background update has finished downloading + installing and is
// staged, so every action is post-download.

import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export interface UpdateReadyToastProps {
  version: string
  /** Show the incoming version's release notes (sidebar card). */
  onSeeChanges: () => void
  /** Apply at the next safe moment instead of now. */
  onRestartIdle: () => void
  /** Relaunch immediately. */
  onRestart: () => void
}

/** Presentational — the three-action card. Exported so the gallery renders the
 * REAL component (with no-op handlers), never a drifting mock. */
export function UpdateReadyToast({
  version,
  onSeeChanges,
  onRestartIdle,
  onRestart,
}: UpdateReadyToastProps) {
  return (
    <div className="w-[380px] rounded-xl bg-popover p-4 shadow-lg ring-1 ring-border">
      <div className="text-body font-semibold text-foreground">New update available</div>
      <div className="mt-0.5 text-footnote text-muted-foreground">
        Octave {version} is ready to install.
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="outline" onClick={onSeeChanges}>
          See changes
        </Button>
        <Button size="sm" variant="outline" onClick={onRestartIdle}>
          Restart when idle
        </Button>
        <Button size="sm" onClick={onRestart}>
          Restart
        </Button>
      </div>
    </div>
  )
}

/** Fire the update-ready toast. One stable id so it replaces any prior update
 * toast. "Restart when idle" dismisses this and confirms; "See changes" leaves
 * it up so the user can still restart. */
export function showUpdateReadyToast(opts: UpdateReadyToastProps) {
  toast.custom(
    (id) => (
      <UpdateReadyToast
        version={opts.version}
        onSeeChanges={opts.onSeeChanges}
        onRestartIdle={() => {
          toast.dismiss(id)
          opts.onRestartIdle()
          toast.success('Will restart when idle', {
            description: 'The update applies at the next safe moment.',
          })
        }}
        onRestart={opts.onRestart}
      />
    ),
    { id: 'octave-update', duration: Infinity },
  )
}
