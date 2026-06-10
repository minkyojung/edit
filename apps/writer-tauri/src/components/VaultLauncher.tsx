// First-run launcher (Obsidian-style "open vault" screen). Shown by BootGate when
// no vault is selected yet. Opens a local folder as the vault.
//
// Restore-from-GitHub was removed — versioning/backup is being redesigned as an
// opt-in layer (GitHub login stays elsewhere). Local folder only for now.
//
// Calls `onReady` once a vault is in place so BootGate proceeds with the normal
// boot sequence.

import { useCallback, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { pickVault } from '@/lib/vaultPicker'

interface Props {
  /** Fired once a vault is ready so BootGate runs the normal boot sequence. */
  onReady: () => void
}

export function VaultLauncher({ onReady }: Props) {
  const handleLocal = useCallback(async () => {
    const path = await pickVault()
    if (path) onReady()
  }, [onReady])

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-center text-2xl font-semibold tracking-tight text-foreground">
          Writer
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          Open a folder on this computer as your vault.
        </p>

        <div className="rounded-xl border bg-card p-2">
          <LauncherRow
            title="Open folder / start fresh"
            desc="Use a folder on this computer as your vault."
            action={<Button onClick={() => void handleLocal()}>Open</Button>}
          />
        </div>
      </div>
    </div>
  )
}

function LauncherRow({
  title,
  desc,
  action,
}: {
  title: string
  desc: string
  action: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg p-3 hover:bg-muted/40">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <div className="flex-none">{action}</div>
    </div>
  )
}
