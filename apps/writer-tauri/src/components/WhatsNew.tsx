// Release-notes UI. After an update lands, the new version's notes appear as
// a dismissible RECTANGLE pinned to the sidebar bottom (not a modal, not a
// thin version row) — a quiet, in-place "here's what changed". Reuses
// react-markdown (same lib the chat renders with), read-only.

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconX } from '@tabler/icons-react'
import { getVersion } from '@tauri-apps/api/app'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { useSettingsStore } from '@/state/settingsStore'
import { changelogFor, type ChangelogEntry } from '@/lib/changelog'

// No typography plugin in this app, so map the handful of elements release
// notes use to tailwind classes. `node` is dropped so it never lands on a
// DOM attribute (react-markdown passes it to every component).
const MD_COMPONENTS: Components = {
  h3: ({ node: _n, ...p }: ComponentPropsWithoutRef<'h3'> & { node?: unknown }) => (
    <h3 className="mt-3 mb-1 text-footnote font-semibold text-foreground first:mt-0" {...p} />
  ),
  p: ({ node: _n, ...p }: ComponentPropsWithoutRef<'p'> & { node?: unknown }) => (
    <p className="my-1.5 text-footnote leading-relaxed text-muted-foreground" {...p} />
  ),
  ul: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ul'> & { node?: unknown }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-4 text-footnote text-muted-foreground" {...p} />
  ),
  ol: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ol'> & { node?: unknown }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-4 text-footnote text-muted-foreground" {...p} />
  ),
  li: ({ node: _n, ...p }: ComponentPropsWithoutRef<'li'> & { node?: unknown }) => (
    <li className="leading-relaxed" {...p} />
  ),
  strong: ({ node: _n, ...p }: ComponentPropsWithoutRef<'strong'> & { node?: unknown }) => (
    <strong className="font-semibold text-foreground" {...p} />
  ),
  code: ({ node: _n, ...p }: ComponentPropsWithoutRef<'code'> & { node?: unknown }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" {...p} />
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

/** The sidebar-bottom "what's new" rectangle: one version's release notes in
 * a bordered card with a dismiss button. Presentational — the stateful
 * wrapper below decides when to show it. */
export function WhatsNewCard({
  entry,
  onDismiss,
}: {
  entry: ChangelogEntry
  onDismiss: () => void
}) {
  return (
    <div className="m-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="text-footnote font-semibold text-foreground">
          What’s new · {entry.version}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <ReleaseNotes notes={entry.notes} />
      </div>
    </div>
  )
}

/** Show the sidebar What's-new card once per version after an update lands
 * (running version differs from the last one acknowledged). Persists until
 * the user dismisses it (unlike a modal that auto-advances on show).
 * Suppressed during onboarding / fresh installs and in per-project windows.
 * Renders nothing when there's nothing new. */
export function WhatsNewSidebar() {
  const lastSeen = useSettingsStore((s) => s.lastWhatsNewVersion)
  const setLastSeen = useSettingsStore((s) => s.setLastWhatsNewVersion)
  const bootstrapCompleted = useSettingsStore((s) => s.bootstrapCompleted)
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)

  useEffect(() => {
    if (WINDOW_ROOT !== null || !bootstrapCompleted) return
    let alive = true
    void getVersion()
      .then((v) => {
        if (!alive || lastSeen === v) return
        const e = changelogFor(v)
        if (e) setEntry(e)
        else setLastSeen(v) // no notes for this version — mark seen silently
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // Mount-once by design: read lastSeen at mount; advancing it on dismiss.
  }, [])

  if (!entry) return null
  return (
    <WhatsNewCard
      entry={entry}
      onDismiss={() => {
        setLastSeen(entry.version)
        setEntry(null)
      }}
    />
  )
}
