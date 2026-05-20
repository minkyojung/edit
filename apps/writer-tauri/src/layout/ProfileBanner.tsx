// Top-of-page banner shown on the wiki:profile page after the URL
// bootstrap flow saves a fresh draft. Tells the user "this was AI-
// generated from your URLs, edit anytime" and gives two corrective
// actions: regenerate (re-open the dialog) or dismiss.
//
// Visibility rules:
//   - active doc must be wiki:profile
//   - settingsStore.profileBootstrappedAt must be set
//   - settingsStore.profileBannerDismissed must be false
//
// Once dismissed it stays gone across reloads until the next URL
// bootstrap (markProfileBootstrapped clears the dismissed flag).

import { useDocsStore } from '@/state/docsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { Button } from '@/components/ui/button'

interface Props {
  /** Callback to re-open the BootstrapDialog so the user can paste
   * different / additional URLs. The dialog itself handles the
   * regenerate flow — overwrites wiki:profile body on save. */
  onRegenerate: () => void
}

export function ProfileBanner({ onRegenerate }: Props) {
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const profileBootstrappedAt = useSettingsStore((s) => s.profileBootstrappedAt)
  const profileBannerDismissed = useSettingsStore((s) => s.profileBannerDismissed)
  const dismiss = useSettingsStore((s) => s.dismissProfileBanner)

  if (!activeSlug) return null
  if (profileBootstrappedAt === null || profileBannerDismissed) return null
  const active = knownDocs.find((d) => d.slug === activeSlug && !d.archivedAt)
  if (!active || active.type !== 'wiki:profile') return null

  return (
    <div className="mx-auto mb-4 flex w-full max-w-3xl items-start justify-between gap-4 rounded-md border border-border bg-muted/40 px-4 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">AI drafted this from your URLs.</p>
        <p className="text-xs text-muted-foreground">
          Edit anything inline — chat already sees what&apos;s here. If the
          draft is off, regenerate with different URLs.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRegenerate}>
          Regenerate
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          aria-label="Dismiss banner"
        >
          ✕
        </Button>
      </div>
    </div>
  )
}
