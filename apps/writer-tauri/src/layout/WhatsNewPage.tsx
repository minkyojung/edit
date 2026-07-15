// What's-new page — the full release-notes surface, reached from the sidebar
// teaser card and the update toast's "See changes". Rendered in the AppShell
// content column like any note view (see SkillsPage) — not a modal. Shows the
// incoming version's notes at top when pinned (pre-install, from the update
// manifest), then the bundled version history.

import { CHANGELOG } from '@/lib/changelog'
import { useWhatsNewStore } from '@/state/whatsNewStore'
import { ReleaseNotes } from '@/components/WhatsNew'

export function WhatsNewPage() {
  const pinned = useWhatsNewStore((s) => s.pinned)

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <h1 className="mb-8 text-title-2 font-semibold text-foreground">What’s new</h1>

      {pinned && (
        <section className="mb-10 rounded-xl border border-border bg-muted/30 p-5">
          <div className="mb-2 text-footnote font-medium text-muted-foreground">
            Coming in Octave {pinned.version}
          </div>
          <ReleaseNotes notes={pinned.notes} />
        </section>
      )}

      <div className="space-y-10">
        {CHANGELOG.map((entry) => (
          <section key={entry.version}>
            <div className="mb-2 flex items-baseline gap-2 border-b border-border/60 pb-1.5">
              <h2 className="text-body font-semibold text-foreground">
                Octave {entry.version}
              </h2>
              {entry.date && (
                <span className="text-footnote text-muted-foreground">{entry.date}</span>
              )}
            </div>
            <ReleaseNotes notes={entry.notes} />
          </section>
        ))}
      </div>
    </div>
  )
}
