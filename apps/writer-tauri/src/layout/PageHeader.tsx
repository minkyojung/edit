/**
 * PageHeader — single header surface for every kind of doc.
 *
 * Sits above the editor body in MilkdownEditor. Reads the doc's
 * known meta and decides what to render — same visual slot for every
 * kind so the page always opens with "what is this page" answered.
 *
 * Decisions:
 *
 *   daily      → date label (read-only). The date is the anchor;
 *                no other name is meaningful.
 *   system     → type-derived label, read-only ("Conventions",
 *                "Log", "Index"). System pages are managed surfaces
 *                that the user doesn't rename.
 *   wiki       → WikiPageTitle (editable input). The cached title
 *                lives in knownDocs and is written by setDocTitle.
 *   writing    → no header. The body's first line is the natural
 *                title slot for free-form writing; rendering a
 *                separate input would compete with that affordance.
 *
 * Why this exists:
 *   The previous "MilkdownEditor decides which header to show"
 *   pattern put the doc-type switch inside an editor component. Each
 *   new doc kind grew the conditional. Centralizing here keeps the
 *   editor focused on the body, and the sidebar / palette / breadcrumb
 *   surfaces that read useDocLabel stay in sync because they read
 *   from the same knownDocs.title field WikiPageTitle writes to.
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

/** Read-only label rendered to match WikiPageTitle's visual weight,
 * so users see the same "page title" affordance regardless of kind. */
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
