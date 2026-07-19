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
import { StatusControl } from './StatusControl'

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

  // User-editable docs (user-owned wiki + writing + notes) get an inline
  // text input that doubles as the file's name on disk, plus a workflow
  // status control above it. This branch is exactly the status-supporting
  // set (daily / system are handled above), so no extra gate is needed.
  return (
    <div>
      <StatusControl slug={slug} status={known.status} />
      <EditableTitleInput slug={slug} currentTitle={known.title} />
    </div>
  )
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
      data-page-title
      aria-label={ariaLabel}
      className="mb-6 w-full text-3xl font-semibold leading-tight text-foreground"
    >
      {label}
    </div>
  )
}
