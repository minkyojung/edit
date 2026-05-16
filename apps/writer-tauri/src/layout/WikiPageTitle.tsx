// Explicit page-title input for any doc whose title is user-editable
// (user-owned wiki pages + writing docs). The previous Wiki-only
// gate left writing pages without a title surface, which split the
// header system into two patterns — one path showed an input, the
// other rendered nothing and relied on the body's first line. This
// component is now agnostic to doc kind; PageHeader decides whether
// to render it.
//
// Reads / writes `knownDocs[].title` via setDocTitle. Empty input
// commits as cleared title (sidebar falls back to 'Untitled').
//
// File name preserved for diff stability; consider renaming to
// PageTitle in a follow-up cleanup pass.

import { useEffect, useState } from 'react'
import { useDocsStore } from '@/state/docsStore'

interface Props {
  slug: string
}

export function WikiPageTitle({ slug }: Props) {
  const known = useDocsStore((s) => s.knownDocs.find((d) => d.slug === slug))
  const setDocTitle = useDocsStore((s) => s.setDocTitle)
  const [local, setLocal] = useState(known?.title ?? '')

  // Sync local state when the slug changes (doc switch) or when the
  // stored title changes from outside (e.g. ingest just created the
  // page with an entity name). The check on local !== stored avoids
  // clobbering in-flight typing if the store fires for an unrelated
  // reason.
  useEffect(() => {
    const stored = known?.title ?? ''
    if (stored !== local) setLocal(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, known?.title])

  if (!known) return null

  function handleChange(next: string) {
    setLocal(next)
    setDocTitle(slug, next)
  }

  return (
    <input
      type="text"
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      placeholder="Untitled"
      aria-label="Page title"
      className="mb-6 w-full bg-transparent text-3xl font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground/40"
    />
  )
}
