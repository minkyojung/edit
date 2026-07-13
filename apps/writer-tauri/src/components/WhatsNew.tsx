// Release-notes UI: a read-only rich render of the bundled changelog
// (src/lib/changelog.ts), plus the auto "What's new" panel shown once after
// an update lands. Reuses react-markdown (same lib the chat renders with),
// read-only — no editing, no wikilinks/viz, just styled prose.

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getVersion } from '@tauri-apps/api/app'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { useSettingsStore } from '@/state/settingsStore'
import { useUpdateStore } from '@/state/updateStore'
import { updater } from '@/lib/updater'
import { CHANGELOG, changelogFor, type ChangelogEntry } from '@/lib/changelog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

// No typography plugin in this app, so map the handful of elements release
// notes use to tailwind classes. `node` is dropped so it never lands on a
// DOM attribute (react-markdown passes it to every component).
const MD_COMPONENTS: Components = {
  h3: ({ node: _n, ...p }: ComponentPropsWithoutRef<'h3'> & { node?: unknown }) => (
    <h3 className="mt-4 mb-1 text-body font-semibold text-foreground first:mt-0" {...p} />
  ),
  p: ({ node: _n, ...p }: ComponentPropsWithoutRef<'p'> & { node?: unknown }) => (
    <p className="my-2 text-body leading-relaxed text-muted-foreground" {...p} />
  ),
  ul: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ul'> & { node?: unknown }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-body text-muted-foreground" {...p} />
  ),
  ol: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ol'> & { node?: unknown }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-body text-muted-foreground" {...p} />
  ),
  li: ({ node: _n, ...p }: ComponentPropsWithoutRef<'li'> & { node?: unknown }) => (
    <li className="leading-relaxed" {...p} />
  ),
  strong: ({ node: _n, ...p }: ComponentPropsWithoutRef<'strong'> & { node?: unknown }) => (
    <strong className="font-semibold text-foreground" {...p} />
  ),
  code: ({ node: _n, ...p }: ComponentPropsWithoutRef<'code'> & { node?: unknown }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-footnote" {...p} />
  ),
  a: ({ node: _n, ...p }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) => (
    <a className="text-foreground underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />
  ),
}

/** Read-only rich render of a release-notes markdown string. */
export function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {notes}
    </ReactMarkdown>
  )
}

/** Modal showing one version's release notes. Shared by the auto panel, the
 * sidebar footer, and the About tab. Renders nothing when `entry` is null. */
export function ReleaseNotesDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: ChangelogEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open && !!entry} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-2">
        <DialogTitle>What’s new in Octave {entry?.version}</DialogTitle>
        {entry && <ReleaseNotes notes={entry.notes} />}
      </DialogContent>
    </Dialog>
  )
}

/** Auto "What's new" after an update. On first render of a NEW version (the
 * running version differs from the last one whose notes were shown), pop the
 * panel once, then advance the marker. Suppressed on a fresh install / the
 * first run after this feature shipped (empty marker) so it never
 * retro-spams or clashes with onboarding. Launcher/main window only, so an
 * update doesn't pop it in every open window. */
export function WhatsNewGate() {
  const lastSeen = useSettingsStore((s) => s.lastWhatsNewVersion)
  const setLastSeen = useSettingsStore((s) => s.setLastWhatsNewVersion)
  const bootstrapCompleted = useSettingsStore((s) => s.bootstrapCompleted)
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (WINDOW_ROOT !== null) return
    // Never during onboarding — a brand-new install shouldn't get a "what's
    // new" panel mid-setup. Existing users (bootstrap done) with an empty
    // marker DO see it: that's an upgrade from a pre-feature version.
    if (!bootstrapCompleted) return
    let alive = true
    void getVersion()
      .then((v) => {
        if (!alive || lastSeen === v) return
        const e = changelogFor(v)
        setLastSeen(v) // advance so it shows at most once per version
        if (e) {
          setEntry(e)
          setOpen(true)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Mount-once by design: we read lastSeen at mount and advance it; adding
    // it as a dep would re-run and re-suppress. Deliberately empty deps.
  }, [])

  return <ReleaseNotesDialog entry={entry} open={open} onOpenChange={setOpen} />
}

/** Sidebar-footer row: the running version + a "What's new" link that opens
 * this version's release notes. When an update is staged (`ready`), the row
 * becomes the actionable "Restart to update" nudge instead — the one update
 * moment worth surfacing persistently (download progress is not). */
export function UpdateFooter() {
  const [version, setVersion] = useState('')
  const [open, setOpen] = useState(false)
  const state = useUpdateStore((s) => s.state)

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

  const entry = version ? changelogFor(version) ?? CHANGELOG[0] ?? null : null

  if (state.status === 'ready') {
    return (
      <button
        type="button"
        onClick={() => void updater.install()}
        className="w-full px-3 py-2 text-left text-footnote text-sidebar-foreground/70 transition-colors hover:text-foreground"
      >
        Restart to update → {state.version}
      </button>
    )
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 text-footnote text-sidebar-foreground/50">
      <span className="tabular-nums">Octave {version || '—'}</span>
      {entry && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="transition-colors hover:text-foreground"
        >
          What’s new
        </button>
      )}
      <ReleaseNotesDialog entry={entry} open={open} onOpenChange={setOpen} />
    </div>
  )
}
