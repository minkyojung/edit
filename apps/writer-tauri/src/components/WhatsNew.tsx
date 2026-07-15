// Release-notes UI. After an update lands, a small TEASER card (one headline)
// pins to the sidebar bottom; clicking it opens the full What's-new PAGE
// (/whats-new) — not a modal, not the whole changelog crammed into the card.
// ReleaseNotes (the read-only rich render) is used by that page + the gallery.

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconX, IconChevronRight } from '@tabler/icons-react'
import { getVersion } from '@tauri-apps/api/app'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { useSettingsStore } from '@/state/settingsStore'
import { changelogFor, type ChangelogEntry } from '@/lib/changelog'

// No typography plugin, so map the elements release notes use to tailwind
// classes. `node` is dropped so it never lands on a DOM attribute. Sized for
// the full What's-new page (the sidebar card is just a headline now).
const MD_COMPONENTS: Components = {
  h3: ({ node: _n, ...p }: ComponentPropsWithoutRef<'h3'> & { node?: unknown }) => (
    <h3 className="mt-5 mb-1.5 text-body font-semibold text-foreground first:mt-0" {...p} />
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

/** The sidebar-bottom teaser: version + the ONE headline + a chevron. Clicking
 * the headline opens the full notes; the × dismisses. Presentational — the
 * stateful wrapper below decides when to show it. */
export function WhatsNewCard({
  version,
  headline,
  onOpen,
  onDismiss,
}: {
  version: string
  headline: string
  onOpen: () => void
  onDismiss: () => void
}) {
  return (
    <div className="m-2 rounded-lg border border-border bg-muted/40 p-2.5">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className="text-footnote font-semibold text-foreground">
          What’s new · {version}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconX size={13} />
        </button>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-start gap-1 text-left text-footnote text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex-1 leading-snug">{headline}</span>
        <IconChevronRight size={14} className="mt-px shrink-0 opacity-60 group-hover:opacity-100" />
      </button>
    </div>
  )
}

/** Show the sidebar teaser once per version after an update lands (running
 * version differs from the last one acknowledged). Clicking opens /whats-new;
 * either that or the × marks the version seen. Suppressed during onboarding /
 * fresh installs and in per-project windows. Renders nothing when nothing's
 * new. */
export function WhatsNewSidebar() {
  const lastSeen = useSettingsStore((s) => s.lastWhatsNewVersion)
  const setLastSeen = useSettingsStore((s) => s.setLastWhatsNewVersion)
  const bootstrapCompleted = useSettingsStore((s) => s.bootstrapCompleted)
  const navigate = useNavigate()
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
        navigate('/whats-new')
      }}
      onDismiss={() => {
        setLastSeen(entry.version)
        setEntry(null)
      }}
    />
  )
}
