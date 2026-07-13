// "About" settings panel — the user-facing surface of the update state
// machine (the "user driver"). Shows the running version and always-visible
// update status with a manual trigger, so a failed update is never a silent
// black box: whatever state Rust broadcasts (checking / available /
// downloading% / ready / error / dev-disabled) shows here, and the button
// swaps to the action that state affords.

import { useEffect, useState, type ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { useUpdateStore } from '@/state/updateStore'
import { updater, type UpdateState } from '@/lib/updater'
import { CHANGELOG, changelogFor } from '@/lib/changelog'
import { ReleaseNotesDialog } from '@/components/WhatsNew'
import { Button } from '@/components/ui/button'
import { SettingRow } from '../SettingRow'

/** Derive the status line + the single action button from the current state. */
function describe(state: UpdateState): { description: string; button: ReactNode } {
  const checkNow = (
    <Button variant="outline" size="sm" onClick={() => void updater.check()}>
      Check now
    </Button>
  )
  switch (state.status) {
    case 'checking':
      return {
        description: 'Checking for updates…',
        button: (
          <Button variant="outline" size="sm" disabled>
            Checking…
          </Button>
        ),
      }
    case 'downloading':
      return {
        description:
          state.percent != null ? `Downloading… ${state.percent}%` : 'Downloading…',
        button: (
          <Button variant="outline" size="sm" disabled>
            Downloading…
          </Button>
        ),
      }
    case 'ready':
      return {
        description: `Version ${state.version} is ready.`,
        button: (
          <Button size="sm" onClick={() => void updater.install()}>
            Restart to update
          </Button>
        ),
      }
    case 'error':
      return { description: `Update failed while trying to ${state.phase}.`, button: checkNow }
    case 'unsupported':
      return {
        description: state.reason,
        button: (
          <Button variant="outline" size="sm" disabled>
            Check now
          </Button>
        ),
      }
    case 'upToDate':
      return { description: "You're on the latest version.", button: checkNow }
    case 'idle':
    default:
      return { description: 'Check for the latest version.', button: checkNow }
  }
}

export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const state = useUpdateStore((s) => s.state)
  const notesEntry = (version ? changelogFor(version) : null) ?? CHANGELOG[0] ?? null

  useEffect(() => {
    let alive = true
    void getVersion()
      .then((v) => {
        if (alive) setVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const { description, button } = describe(state)

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">About</h2>
      <SettingRow title="Version" description="The version of Octave you're running.">
        <span className="font-mono text-footnote text-muted-foreground">
          {version ?? '—'}
        </span>
      </SettingRow>
      <SettingRow title="Updates" description={description}>
        {button}
      </SettingRow>
      {state.status === 'error' && (
        <p className="mt-1 whitespace-pre-wrap text-footnote text-destructive">
          {state.message}
        </p>
      )}
      {notesEntry && (
        <SettingRow title="Release notes" description="What changed in this version.">
          <Button variant="outline" size="sm" onClick={() => setNotesOpen(true)}>
            View
          </Button>
        </SettingRow>
      )}
      <ReleaseNotesDialog entry={notesEntry} open={notesOpen} onOpenChange={setNotesOpen} />
    </section>
  )
}
