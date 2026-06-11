/**
 * PageHeader — single header surface for every kind of doc.
 *
 * Sits above the editor body. Decides what to render based on doc
 * kind; the editor itself stays agnostic.
 *
 *   daily          → read-only date label ("Saturday, May 16")
 *   system         → read-only type label ("Conventions" / "Log" / ...)
 *   wiki + writing → editable input (Obsidian / Notion pattern). The
 *                    input value IS the file's name on disk; editing
 *                    commits via renameDoc → fs.rename. Body is
 *                    independent — Path C Step 4 decoupled body and
 *                    title so AI / user body edits don't silently
 *                    rename the file.
 */

import { useRef } from 'react'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { useObservePageTitle } from '@/hooks/useObservePageTitle'
import { EditableTitleInput } from './EditableTitleInput'
import { YoutubeHeader } from './YoutubeHeader'

interface Props {
  slug: string
}

export function PageHeader({ slug }: Props) {
  const known = useDocsStore((s) => s.knownDocs.find((d) => d.slug === slug))
  const label = useDocLabel(slug)

  if (!known) return null

  // Daily entries: date is the anchor.
  if (known.type === 'daily') {
    return <ReadOnlyHeader label={label} ariaLabel="Daily date" />
  }

  // System pages (system:log / system:conventions / system:index)
  // surface a fixed name pulled from the type id. Read-only because
  // they are agent-managed.
  if (isWikiDoc(known) && known.type.startsWith('system:')) {
    return <ReadOnlyHeader label={label} ariaLabel="System page" />
  }

  // Captured YouTube videos get a metadata card (thumbnail / channel /
  // duration / source link) instead of an editable title — the title is
  // the video's, not something the user names.
  if (known.type === 'youtube') {
    return <YoutubeHeader known={known} />
  }

  // User-editable docs (user-owned wiki + writing) get an inline
  // text input that doubles as the file's name on disk. See
  // EditableTitleInput for commit semantics (Enter / Blur).
  return <EditableTitleInput slug={slug} currentTitle={known.title} />
}

/** Read-only label rendered with the same visual weight across kinds
 * so the page always opens with a clear "what is this" anchor. */
function ReadOnlyHeader({
  label,
  ariaLabel,
}: {
  label: string
  ariaLabel: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useObservePageTitle(ref)
  return (
    <div
      ref={ref}
      aria-label={ariaLabel}
      className="mb-6 w-full text-3xl font-semibold leading-tight text-foreground"
    >
      {label}
    </div>
  )
}
