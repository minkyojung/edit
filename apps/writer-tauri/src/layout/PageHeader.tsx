/**
 * PageHeader — single header surface for every kind of doc.
 *
 * Sits above the editor body. Decides what to render based on doc
 * kind; the editor itself stays agnostic.
 *
 *   daily   → read-only date label ("Saturday, May 16")
 *   system  → read-only type label ("Conventions" / "Log" / "Index")
 *   wiki + writing → no header. The body's first line plays the
 *                    title role (Bear / iA Writer pattern). The
 *                    title mirror (docsStore.installTitleMirror)
 *                    promotes the first block into knownDocs.title
 *                    so sidebar / palette stay in sync.
 */

import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'

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

  // User-editable docs (user-owned wiki + writing) follow a
  // single pattern: no separate header surface. The body's first
  // line plays the title role — visually it's the biggest text
  // on the page (heading style), and the title-mirror keeps
  // knownDocs.title in sync from the body's first block. This
  // matches Bear / iA Writer / Ulysses for writing and removes
  // the previous split between "wiki has an input" and "writing
  // has the body's first line". One rule everywhere.
  return null
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
  return (
    <div
      aria-label={ariaLabel}
      className="mb-6 w-full text-3xl font-semibold leading-tight text-foreground"
    >
      {label}
    </div>
  )
}
