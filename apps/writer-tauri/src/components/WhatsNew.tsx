// Release-notes UI. After an update lands, a small TEASER card (one headline)
// pins to the sidebar bottom; clicking it opens Settings ▸ About, whose
// "Release notes" section shows the full history — not a modal, not the whole
// changelog crammed into the card. ReleaseNotesHistory renders that section
// (reused by the gallery).

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconX } from '@tabler/icons-react'
import { getVersion } from '@tauri-apps/api/app'
import { useSettingsStore } from '@/state/settingsStore'
import { useWhatsNewStore } from '@/state/whatsNewStore'
import { openSettings } from '@/settings/useSettingsDialog'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { CHANGELOG, changelogFor, type ChangelogEntry } from '@/lib/changelog'

// No typography plugin, so map the elements release notes use to tailwind
// classes. `node` is dropped so it never lands on a DOM attribute. Sized for
// the full What's-new page (the sidebar card is just a headline now).
const MD_COMPONENTS: Components = {
  // Section labels inside a release — demoted to a small muted "eyebrow" so
  // they sit clearly BELOW the version header (which is the anchor), not
  // competing with it at the same weight.
  h3: ({ node: _n, ...p }: ComponentPropsWithoutRef<'h3'> & { node?: unknown }) => (
    <h3
      className="mt-4 mb-1 text-footnote font-semibold uppercase tracking-wide text-muted-foreground first:mt-0"
      {...p}
    />
  ),
  p: ({ node: _n, ...p }: ComponentPropsWithoutRef<'p'> & { node?: unknown }) => (
    <p className="my-2 text-body leading-relaxed text-muted-foreground" {...p} />
  ),
  ul: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ul'> & { node?: unknown }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5 text-body text-muted-foreground" {...p} />
  ),
  ol: ({ node: _n, ...p }: ComponentPropsWithoutRef<'ol'> & { node?: unknown }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5 text-body text-muted-foreground" {...p} />
  ),
  li: ({ node: _n, ...p }: ComponentPropsWithoutRef<'li'> & { node?: unknown }) => (
    <li className="leading-relaxed" {...p} />
  ),
  strong: ({ node: _n, ...p }: ComponentPropsWithoutRef<'strong'> & { node?: unknown }) => (
    <strong className="font-semibold text-foreground" {...p} />
  ),
  em: ({ node: _n, ...p }: ComponentPropsWithoutRef<'em'> & { node?: unknown }) => (
    <em className="italic" {...p} />
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

/** The full release-notes history: the incoming version's notes at top when
 * pinned (pre-install, from the update toast's "See changes"), then every
 * bundled version newest-first. Rendered inside the About settings section
 * (always reachable) and previewed in the gallery. */
export function ReleaseNotesHistory() {
  const pinned = useWhatsNewStore((s) => s.pinned)
  return (
    <div>
      {pinned && (
        <section className="mb-8 rounded-lg border border-border bg-muted/30 p-4">
          <Badge variant="secondary" className="mb-2">
            Coming in {pinned.version}
          </Badge>
          <ReleaseNotes notes={pinned.notes} />
        </section>
      )}
      {CHANGELOG.map((entry, i) => (
        <section key={entry.version}>
          {i > 0 && <Separator className="my-8" />}
          {/* Version = the anchor: a larger title + a Latest badge on the
              newest, with the date pushed to the right as secondary info. */}
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-title-3 font-semibold text-foreground">
              {entry.version}
            </h2>
            {i === 0 && <Badge>Latest</Badge>}
            {entry.date && (
              <span className="ml-auto text-footnote tabular-nums text-muted-foreground">
                {entry.date}
              </span>
            )}
          </div>
          <ReleaseNotes notes={entry.notes} />
        </section>
      ))}
    </div>
  )
}

/** The sidebar-bottom teaser: version + the ONE headline + a chevron. Clicking
 * the headline opens the full notes; the × dismisses. Presentational — the
 * stateful wrapper below decides when to show it. */
export function WhatsNewCard({
  headline,
  onOpen,
  onDismiss,
}: {
  /** Accepted for call-site parity; shown only in the full notes, not the chip. */
  version?: string
  headline: string
  onOpen: () => void
  onDismiss: () => void
}) {
  return (
    <div className="group m-2 flex items-center gap-2 rounded-3xl border border-border bg-muted px-3 py-2">
      <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-px text-caption-2 font-semibold uppercase tracking-wide text-foreground">
        New
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-footnote text-muted-foreground transition-colors hover:text-foreground"
      >
        {headline}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <IconX size={13} />
      </button>
    </div>
  )
}

/** Show the sidebar teaser once per version after an update lands (running
 * version differs from the last one acknowledged). Clicking opens Settings ▸
 * About; either that or the × marks the version seen. Suppressed until
 * bootstrap completes (onboarding / fresh installs). Renders nothing when
 * nothing's new. */
export function WhatsNewSidebar() {
  const lastSeen = useSettingsStore((s) => s.lastWhatsNewVersion)
  const setLastSeen = useSettingsStore((s) => s.setLastWhatsNewVersion)
  const bootstrapCompleted = useSettingsStore((s) => s.bootstrapCompleted)
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)

  useEffect(() => {
    if (!bootstrapCompleted) return
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
    // Mount-once by design: read lastSeen at mount; advance it on open/dismiss.
  }, [])

  if (!entry) return null
  return (
    <WhatsNewCard
      version={entry.version}
      headline={entry.headline}
      onOpen={() => {
        setLastSeen(entry.version)
        setEntry(null)
        openSettings('about')
      }}
      onDismiss={() => {
        setLastSeen(entry.version)
        setEntry(null)
      }}
    />
  )
}
